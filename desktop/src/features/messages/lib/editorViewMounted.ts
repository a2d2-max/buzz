import type { Editor } from "@tiptap/core";

/**
 * Whether the editor's ProseMirror view is currently attached.
 *
 * TipTap v3 creates the `Editor` object before a view exists and can drop the
 * view again (`unmount()`, `destroy()`) while consumers still hold the editor.
 * While the view is gone, `editor.view` returns a stub that throws on most
 * property access (`dom`, `focus`, `setProps`, …) — only `state`/`dispatch`
 * keep working. Any view-touching call must therefore be gated on this check
 * or deferred to the editor's `"mount"` event.
 *
 * There is no public "is the view mounted" flag: `editor.isInitialized` turns
 * on one tick *after* mount (the `"create"` event), so probing `view.dom` —
 * whose throw-when-unmounted behaviour is the documented contract — is the
 * reliable test.
 */
export function isEditorViewMounted(editor: Editor | null): boolean {
  if (!editor || editor.isDestroyed) return false;
  try {
    return Boolean(editor.view.dom);
  } catch {
    return false;
  }
}
