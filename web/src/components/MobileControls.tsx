import { useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../api';
import { Close, Photo, Send } from './icons';

const KEYS: { label: string; key: string; aria?: string }[] = [
  { label: 'Esc', key: 'Escape' },
  { label: '^C', key: 'C-c', aria: 'Control C' },
  { label: '⇧Tab', key: 'BTab', aria: 'Shift Tab' },
  { label: 'Tab', key: 'Tab' },
  { label: '↑', key: 'Up', aria: 'Up arrow' },
  { label: '↓', key: 'Down', aria: 'Down arrow' },
  { label: '←', key: 'Left', aria: 'Left arrow' },
  { label: '→', key: 'Right', aria: 'Right arrow' },
  { label: '⏎', key: 'Enter', aria: 'Enter' },
];

/** Keys phones don't have, sent straight to the claude window. */
export function KeyBar({ sessionId }: { sessionId: string }) {
  const [error, setError] = useState<string | null>(null);
  const press = (key: string) => {
    setError(null);
    api.keys(sessionId, [key]).catch((err) => setError(errorMessage(err)));
  };
  return (
    <>
      <div className="keybar" role="group" aria-label="Terminal keys">
        {KEYS.map((k) => (
          <button key={k.key} type="button" className="key" aria-label={k.aria} onClick={() => press(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/** Image types agents read as they are. */
const READABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** The longest side of a sent image. Agents scale bigger ones down anyway; this keeps uploads quick. */
const MAX_SIDE = 2048;

/**
 * A picked image as an agent can read it, at a size it uses: photos off a phone are large, and may
 * be HEIC. GIFs go as they are, to keep their frames.
 */
async function prepareImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // the server says if it can't take it
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && READABLE.includes(file.type)) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // PNG keeps a screenshot sharp (and its transparency); photos go as JPEG.
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? file), type, 0.85));
}

/** An image waiting to go with the next message: its path on the computer, and a thumbnail. */
interface Attached {
  path: string;
  url: string;
}

/**
 * A normal text box that pastes into Claude's prompt and presses Enter. On a keyboard,
 * Enter sends and Shift+Enter adds a line; on a phone the Send button sends.
 * Images (picked, or pasted into the box) upload straight away and go ahead of the text.
 */
export function Composer({ sessionId, working, submitOnEnter }: { sessionId: string; working?: boolean; submitOnEnter?: boolean }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<Attached[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const attach = async (files: File[]) => {
    setError(null);
    setUploading((n) => n + files.length);
    // One at a time, so they go in the order they were picked.
    for (const file of files) {
      try {
        const image = await prepareImage(file);
        const { path } = await api.uploadImage(sessionId, image);
        setImages((list) => [...list, { path, url: URL.createObjectURL(image) }]);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const remove = (image: Attached) => {
    URL.revokeObjectURL(image.url);
    setImages((list) => list.filter((i) => i !== image));
  };

  const ready = (text.trim() !== '' || images.length > 0) && uploading === 0;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.text(sessionId, text.trim() ? text : '', true, images.map((i) => i.path));
      setText('');
      images.forEach((i) => URL.revokeObjectURL(i.url));
      setImages([]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    void attach(files);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (submitOnEnter && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <>
      {(images.length > 0 || uploading > 0) && (
        <div className="attachments" aria-label="Images to send">
          {images.map((image) => (
            <div key={image.path} className="attachment">
              <img src={image.url} alt="" />
              <button type="button" aria-label="Remove image" onClick={() => remove(image)}>
                <Close size={14} />
              </button>
            </div>
          ))}
          {Array.from({ length: uploading }, (_, i) => (
            <div key={i} className="attachment uploading" aria-label="Uploading image" />
          ))}
        </div>
      )}
      <form className="composer" onSubmit={(e) => void submit(e)}>
        {working && (
          <button type="button" className="interrupt" onClick={() => void api.keys(sessionId, ['Escape'])} aria-label="Interrupt Claude (Esc)">
            Interrupt
          </button>
        )}
        <button type="button" className="attach" aria-label="Add images" onClick={() => picker.current?.click()}>
          <Photo size={22} />
        </button>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void attach([...(e.target.files ?? [])]);
            e.target.value = ''; // so the same image can be picked again
          }}
        />
        <textarea
          aria-label="Message Claude"
          placeholder={working ? 'Claude is working… you can queue a message' : 'Message Claude…'}
          rows={Math.min(4, Math.max(1, text.split('\n').length))}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button type="submit" className="send" aria-label="Send" disabled={sending || !ready}>
          <Send size={20} />
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/** Terminal tab controls on a phone: the key bar plus the composer. */
export function MobileControls({ sessionId }: { sessionId: string }) {
  return (
    <div className="mobile-controls">
      <KeyBar sessionId={sessionId} />
      <Composer sessionId={sessionId} />
    </div>
  );
}
