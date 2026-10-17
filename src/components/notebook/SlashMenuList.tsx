import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

export default forwardRef((props: any, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectItem = (index: number) => {
    const item = props.items[index];
    if (item && !item.disabled) {
      props.command(item);
    }
  };

  const upHandler = () => {
    if (!props.items.length) return;
    setSelectedIndex((selectedIndex + props.items.length - 1) % props.items.length);
  };

  const downHandler = () => {
    if (!props.items.length) return;
    setSelectedIndex((selectedIndex + 1) % props.items.length);
  };

  const enterHandler = () => {
    selectItem(selectedIndex);
  };

  useEffect(() => {
    setSelectedIndex(0);
  }, [props.items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: any) => {
      if (event.key === 'ArrowUp') {
        upHandler();
        return true;
      }
      if (event.key === 'ArrowDown') {
        downHandler();
        return true;
      }
      if (event.key === 'Enter') {
        if (!props.items.length) return false;
        enterHandler();
        return true;
      }
      return false;
    },
  }));

  return (
    <div role="listbox" aria-label={props.title ?? 'Block commands'} className={`flex flex-col gap-0.5 p-1.5 overflow-y-auto overscroll-contain text-panvas-text-primary ${props.embedded ? 'max-h-44' : 'w-60 max-h-64 rounded-lg border border-panvas-border-strong bg-panvas-bg-primary shadow-xl'}`}>
      <div className="text-2xs font-medium text-panvas-text-secondary px-2 py-1">{props.title ?? 'Block commands'}</div>
      {props.items.length ? (
        props.items.map((item: any, index: number) => (
          <button
            key={item.value ?? item.title}
            role="option"
            aria-selected={index === selectedIndex}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            title={item.disabled ? item.disabledReason : undefined}
            onMouseDown={event => event.preventDefault()}
            ref={element => {
              if (index !== selectedIndex || !element?.parentElement) return;
              const list = element.parentElement, top = element.offsetTop - list.offsetTop;
              if (top < list.scrollTop || top + element.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top;
            }}
            onClick={() => selectItem(index)}
            className={`flex min-h-8 items-center gap-2 px-2 py-1.5 text-xs rounded-md text-left focus-ring disabled:opacity-40 disabled:cursor-not-allowed ${
              index === selectedIndex ? 'bg-panvas-bg-hover text-panvas-text-primary font-medium' : 'text-panvas-text-primary hover:bg-panvas-bg-hover'
            }`}
          >
            <div className="text-panvas-text-secondary">{item.icon}</div>
            {item.title}
          </button>
        ))
      ) : (
        <div className="text-panvas-text-secondary px-2 py-1.5 text-sm">No result</div>
      )}
    </div>
  );
});
