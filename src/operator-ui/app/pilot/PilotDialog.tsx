import { useId, useLayoutEffect, useRef, useState } from "react";

import { COPY, describeMismatch, type DialogCopy } from "./pilot-copy";

/**
 * One confirmation: what will happen in one plain sentence, the one exact phrase to type (shown and copyable), and nothing
 * filled in for the person. The button stays off until what was typed equals the phrase, and the box says in words how it
 * differs until then. The server compares the answer again, so this is help and not the gate.
 *
 * Keyboard and screen reader: the dialog is modal, focus moves to the box when it opens, Tab stays inside it, and Escape
 * cancels. The page behind it is made inert while it is open, and focus goes back there when it closes (both in PilotWizard): the
 * dialog hands `onClosed` the element that had focus when it opened, because it cannot move focus into a page that is still inert.
 */
export function PilotDialog(props: {
  copy: DialogCopy;
  phrase: string;
  busy: boolean;
  onSubmit: (typed: string) => void;
  onCancel: () => void;
  onClosed: (opener: HTMLElement | null) => void;
}) {
  const { copy, phrase } = props;
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  const ids = { title: useId(), why: useId(), hint: useId(), input: useId() };
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const matches = typed === phrase;

  // Focus moves into the dialog in the same commit that shows it (a layout effect, flushed before the browser paints and before any
  // passive effect of the page behind), so there is no moment in which the dialog is on screen with focus still behind it.
  // On close, the element that had focus before is handed to the page, which restores focus once it is no longer inert. The callback
  // is read through a ref, so the one it was given last is called.
  const onClosed = useRef(props.onClosed);
  onClosed.current = props.onClosed;
  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => { onClosed.current(before); };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
      return;
    }
    if (event.key !== "Tab" || !boxRef.current) return;
    const items = Array.from(boxRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input"));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const copyPhrase = async () => {
    try {
      await navigator.clipboard.writeText(phrase);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  };

  return (
    <div className="pilot-backdrop">
      <div
        ref={boxRef}
        className="pilot-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-describedby={ids.why}
        onKeyDown={onKeyDown}
        {...(copy.jargonOk ? { "data-jargon-ok": "true" } : {})}
      >
        <h2 id={ids.title}>{copy.title}</h2>
        <p id={ids.why} className="pilot-consequence">{copy.consequence}</p>
        <p className="pilot-phrase-label">Type exactly this:</p>
        <p>
          <code className="pilot-phrase" data-phrase="true">{phrase}</code>{" "}
          <button type="button" className="pilot-secondary" onClick={() => void copyPhrase()}>{COPY.copy}</button>
          <span role="status" aria-live="polite" className="pilot-copy-status">
            {copied === "yes" ? " " + COPY.copied : copied === "no" ? " " + COPY.copyFailed : ""}
          </span>
        </p>
        <label htmlFor={ids.input}>{copy.inputLabel}</label>
        <input
          id={ids.input}
          ref={inputRef}
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={typed}
          aria-describedby={ids.hint}
          aria-invalid={typed !== "" && !matches}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            // Enter confirms only what the person typed, and only when it is exact.
            if (event.key === "Enter" && matches && !props.busy) { event.preventDefault(); props.onSubmit(typed); }
          }}
        />
        <p id={ids.hint} role="status" aria-live="polite" className={matches ? "pilot-hint pilot-hint-ok" : "pilot-hint"}>
          {matches ? "It matches." : describeMismatch(typed, phrase)}
        </p>
        <div className="pilot-actions">
          <button type="button" disabled={!matches || props.busy} onClick={() => props.onSubmit(typed)}>{copy.confirm}</button>
          <button type="button" className="pilot-secondary" onClick={props.onCancel}>{copy.cancel}</button>
        </div>
      </div>
    </div>
  );
}
