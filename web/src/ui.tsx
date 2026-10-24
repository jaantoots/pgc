import { createSignal, For, type JSX, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';

// ---- toasts ----
const [toasts, setToasts] = createSignal<{ id: number; text: string; kind: 'info' | 'error' }[]>([]);
let toastId = 0;

export function toast(text: string, kind: 'info' | 'error' = 'info') {
  const id = ++toastId;
  setToasts((t) => [...t, { id, text, kind }]);
  setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 2200);
}

export function Toasts() {
  return (
    <div class="toasts">
      <For each={toasts()}>{(t) => <div class={`toast ${t.kind}`}>{t.text}</div>}</For>
    </div>
  );
}

// ---- context menu ----
export interface MenuItem {
  label: string;
  hint?: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
}

const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(null);

export function openMenu(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  setMenu({ x: e.clientX, y: e.clientY, items });
}

export function ContextMenu() {
  let el: HTMLDivElement | undefined;
  const close = () => setMenu(null);
  const onDown = (e: MouseEvent) => {
    if (el && !el.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  onMount(() => {
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
  });
  onCleanup(() => {
    window.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
  });
  return (
    <Show when={menu()}>
      {(m) => {
        const x = Math.min(m().x, window.innerWidth - 240);
        const y = Math.min(m().y, window.innerHeight - m().items.length * 28 - 16);
        return (
          <div class="menu" ref={el} style={{ left: `${x}px`, top: `${y}px` }}>
            <For each={m().items}>
              {(it) =>
                it.separator ? (
                  <div class="menu-sep" />
                ) : (
                  <button
                    class="menu-item"
                    disabled={it.disabled}
                    onClick={() => {
                      close();
                      it.action?.();
                    }}
                  >
                    <span>{it.label}</span>
                    <Show when={it.hint}>
                      <span class="hint">{it.hint}</span>
                    </Show>
                  </button>
                )
              }
            </For>
          </div>
        );
      }}
    </Show>
  );
}

// ---- modal ----
export function Modal(props: { title?: string; onClose: () => void; children: JSX.Element; wide?: boolean; class?: string }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      props.onClose();
    }
  };
  onMount(() => window.addEventListener('keydown', onKey, true));
  onCleanup(() => window.removeEventListener('keydown', onKey, true));
  return (
    <Portal>
      <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
        <div class={`modal ${props.wide ? 'wide' : ''} ${props.class ?? ''}`}>
          <Show when={props.title}>
            <div class="modal-head">
              <span>{props.title}</span>
              <button class="icon-btn" title="Close (Esc)" onClick={props.onClose}>
                ✕
              </button>
            </div>
          </Show>
          {props.children}
        </div>
      </div>
    </Portal>
  );
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl+';
