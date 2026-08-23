"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface CapabilityItem {
  title: string;
  description: string;
}

interface VersionCapabilitiesDialogProps {
  items: CapabilityItem[];
  shortName: string;
  version: string;
}

export function VersionCapabilitiesDialog({
  items,
  shortName,
  version,
}: VersionCapabilitiesDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  return (
    <>
      <button
        className="glass-control w-fit rounded-full px-3.5 py-2 text-xs font-semibold text-foreground transition hover:text-primary"
        onClick={() => setIsOpen(true)}
        type="button"
      >
        {version}
      </button>

      {isOpen && isMounted
        ? createPortal(
            <div
              aria-modal="true"
              className="top-sheet-backdrop fixed inset-0 z-[999] flex items-start justify-center px-4 pt-20"
              onClick={() => setIsOpen(false)}
              role="dialog"
            >
              <div
                className="top-sheet-surface w-full max-w-2xl rounded-[2rem] p-6"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                      {shortName}
                    </p>
                    <h2 className="mt-2 text-xl font-bold text-foreground">
                      {version} Capability Scope
                    </h2>
                  </div>
                  <button
                    className="glass-control rounded-full px-3 py-1.5 text-xs font-semibold text-foreground transition hover:text-primary"
                    onClick={() => setIsOpen(false)}
                    type="button"
                  >
                    Close
                  </button>
                </div>

                <ol className="mt-5 space-y-3 text-sm leading-6 text-foreground">
                  {items.map((item, index) => (
                    <li
                      className="top-sheet-tile flex gap-3 rounded-2xl px-4 py-3"
                      key={item.title}
                    >
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                        {index + 1}
                      </span>
                      <span>
                        <span className="font-semibold">{item.title}: </span>
                        {item.description}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
