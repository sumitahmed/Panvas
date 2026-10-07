import { createHash } from 'node:crypto';

export interface FakeDriveFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  content?: Uint8Array;
  size?: string;
  md5Checksum?: string;
  version: string;
  trashed?: boolean;
}

export interface DriveRequest {
  method: string;
  url: URL;
  name?: string;
  uploadedBytes?: number;
  downloadedBytes?: number;
}

/** File IDs are the keys: Drive deliberately permits duplicate names/parents. */
export class FakeCloudDrive {
  files = new Map<string, FakeDriveFile>();
  sessions = new Map<string, { id: string; name: string; parents: string[] }>();
  requests: DriveRequest[] = [];
  creates: string[] = [];
  activeDownloads = 0; maxDownloads = 0;
  activeUploads = 0; maxUploads = 0;
  private nextId = 1;
  private fault: { matches: (request: DriveRequest) => boolean; mode: number | 'lost-response' } | null = null;

  resetCounts() {
    this.requests = []; this.creates = []; this.maxDownloads = 0; this.maxUploads = 0;
  }

  failOnce(matches: (request: DriveRequest) => boolean, mode: number | 'lost-response') {
    this.fault = { matches, mode };
  }

  add(name: string, parentId: string, content?: Uint8Array, id = `file-${this.nextId++}`): FakeDriveFile {
    const file: FakeDriveFile = { id, name, parents: [parentId], mimeType: content ? 'application/octet-stream' : 'application/vnd.google-apps.folder', version: '1' };
    if (content) this.setContent(file, content);
    this.files.set(id, file);
    return file;
  }

  private setContent(file: FakeDriveFile, bytes: Uint8Array) {
    file.content = bytes.slice(); file.size = String(bytes.byteLength);
    file.md5Checksum = createHash('md5').update(bytes).digest('hex');
  }

  private metadata(file: FakeDriveFile) {
    const { content: _content, ...metadata } = file;
    return metadata;
  }

  duplicates() {
    const groups = new Map<string, FakeDriveFile[]>();
    for (const file of this.files.values()) {
      if (file.trashed) continue;
      const key = `${file.parents.join(',')}:${file.name}`;
      groups.set(key, [...(groups.get(key) ?? []), file]);
    }
    return [...groups.values()].filter(files => files.length > 1);
  }

  counts() {
    const isObject = (request: DriveRequest) => /^[a-f0-9]{64}$/.test(request.name ?? '');
    return {
      requests: this.requests.length,
      bytesUploaded: this.requests.reduce((sum, request) => sum + (request.uploadedBytes ?? 0), 0),
      bytesDownloaded: this.requests.reduce((sum, request) => sum + (request.downloadedBytes ?? 0), 0),
      metadata: this.requests.filter(r => r.method === 'GET' && /^\/drive\/v3\/files\/[^/]+$/.test(r.url.pathname) && r.url.searchParams.has('fields') && !r.url.pathname.endsWith('generateIds')).length,
      objectMetadata: this.requests.filter(r => isObject(r) && r.method === 'GET' && r.url.searchParams.has('fields')).length,
      objectLists: this.requests.filter(r => r.method === 'GET' && r.url.pathname === '/drive/v3/files' && !r.url.searchParams.get('q')?.includes('name =') && !r.url.searchParams.get('q')?.includes('mimeType =')).length,
      downloads: this.requests.filter(r => isObject(r) && r.url.searchParams.get('alt') === 'media').length,
      maxDownloads: this.maxDownloads,
      objectCreates: this.creates.filter(name => /^[a-f0-9]{64}$/.test(name)).length,
      maxUploads: this.maxUploads,
      jsonWrites: this.requests.filter(r => (r.method === 'PATCH' || r.method === 'POST') && r.name?.endsWith('.json')).length,
    };
  }

  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const method = init.method?.toUpperCase() ?? 'GET';
    const request: DriveRequest = { url, method };
    const fileId = url.pathname.split('/').pop()!;
    const file = this.files.get(fileId);
    request.name = file?.name;
    this.requests.push(request);
    let fault: number | 'lost-response' | undefined;
    if (this.fault?.matches(request)) { fault = this.fault.mode; this.fault = null; }
    if (typeof fault === 'number') return new Response('{}', { status: fault });
    const lostResponse = <T>(value: T): T => {
      if (fault === 'lost-response') throw new DOMException('Response lost after server committed', 'AbortError');
      return value;
    };

    if (url.pathname === '/drive/v3/files/generateIds') return Response.json({ ids: [`file-${this.nextId++}`] });
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const names = [...q.matchAll(/name\s*=\s*'([^']+)'/g)].map(match => match[1]);
      const parent = /'([^']+)'\s*in\s*parents/.exec(q)?.[1];
      const mime = /mimeType\s*=\s*'([^']+)'/.exec(q)?.[1];
      const matches = [...this.files.values()].filter(f => !f.trashed && (!names.length || names.includes(f.name)) && (!parent || f.parents.includes(parent)) && (!mime || mime === f.mimeType));
      // Reverse insertion order makes accidental last-wins canonical selection visible.
      matches.reverse();
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 100);
      return Response.json({ files: matches.slice(offset, offset + pageSize).map(f => this.metadata(f)), ...(offset + pageSize < matches.length ? { nextPageToken: String(offset + pageSize) } : {}) });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const metadata = JSON.parse(String(init.body));
      request.name = metadata.name;
      if (this.files.has(metadata.id)) return new Response(null, { status: 409 });
      const created = this.add(metadata.name, metadata.parents?.[0] ?? 'root', undefined, metadata.id);
      this.creates.push(metadata.name);
      return lostResponse(Response.json(this.metadata(created)));
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      if (url.searchParams.get('uploadType') === 'resumable') {
        const metadata = JSON.parse(String(init.body)); request.name = metadata.name;
        if (this.files.has(metadata.id)) return new Response(null, { status: 409 });
        this.sessions.set(metadata.id, metadata);
        return lostResponse(new Response(null, { status: 200, headers: { Location: `https://fake-drive.test/resumable/${metadata.id}` } }));
      }
      const body = Buffer.from(init.body as Uint8Array);
      const firstHeaderEnd = body.indexOf('\r\n\r\n');
      const metadataEnd = body.indexOf('\r\n--', firstHeaderEnd + 4);
      const metadata = JSON.parse(body.subarray(firstHeaderEnd + 4, metadataEnd).toString());
      request.name = metadata.name;
      if (this.files.has(metadata.id)) return new Response(null, { status: 409 });
      const contentStart = body.indexOf('\r\n\r\n', metadataEnd) + 4;
      const contentEnd = body.lastIndexOf('\r\n--');
      const bytes = body.subarray(contentStart, contentEnd);
      request.uploadedBytes = bytes.byteLength;
      this.activeUploads++; this.maxUploads = Math.max(this.maxUploads, this.activeUploads);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        // Creation is atomic by ID, even though names are not unique.
        if (this.files.has(metadata.id)) return new Response(null, { status: 409 });
        const created = this.add(metadata.name, metadata.parents[0], bytes, metadata.id);
        this.creates.push(metadata.name);
        return lostResponse(Response.json(this.metadata(created)));
      } finally { this.activeUploads--; }
    }
    if (url.pathname.startsWith('/resumable/') && method === 'PUT') {
      const session = this.sessions.get(fileId);
      if (!session) return new Response(null, { status: 404 });
      request.name = session.name;
      request.uploadedBytes = (init.body as Uint8Array).byteLength;
      this.activeUploads++; this.maxUploads = Math.max(this.maxUploads, this.activeUploads);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        let created = this.files.get(fileId);
        if (!created) {
          created = this.add(session.name, session.parents[0], init.body as Uint8Array, fileId);
          this.creates.push(session.name);
        } else this.setContent(created, init.body as Uint8Array);
        return lostResponse(Response.json(this.metadata(created)));
      } finally { this.activeUploads--; }
    }
    if (url.pathname.startsWith('/upload/drive/v3/files/') && method === 'PATCH') {
      if (!file || file.trashed) return new Response(null, { status: 404 });
      this.setContent(file, new TextEncoder().encode(String(init.body)));
      request.uploadedBytes = file.content!.byteLength;
      file.version = String(Number(file.version) + 1);
      return lostResponse(Response.json(this.metadata(file)));
    }
    if (url.pathname.startsWith('/drive/v3/files/') && method === 'GET') {
      if (!file || file.trashed) return new Response(null, { status: 404 });
      if (url.searchParams.get('alt') !== 'media') return Response.json(this.metadata(file));
      if (!file.content) return new Response(null, { status: 404 });
      request.downloadedBytes = file.content.byteLength;
      const isObject = /^[a-f0-9]{64}$/.test(file.name);
      if (isObject) { this.activeDownloads++; this.maxDownloads = Math.max(this.maxDownloads, this.activeDownloads); }
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        return new Response(file.content.slice() as BodyInit);
      } finally { if (isObject) this.activeDownloads--; }
    }
    throw new Error(`Unexpected fake Drive request: ${method} ${url}`);
  };
}
