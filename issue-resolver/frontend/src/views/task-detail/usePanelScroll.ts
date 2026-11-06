import { useEffect, type RefObject } from "react";

interface UsePanelScrollInput {
  issueId: string | null | undefined;
  panelRef: RefObject<HTMLDivElement | null>;
  iterationsRef: RefObject<HTMLDivElement | null>;
  scrollToIterations: boolean;
  onScrolled: () => void;
}

export function usePanelScroll({
  issueId,
  panelRef,
  iterationsRef,
  scrollToIterations,
  onScrolled,
}: UsePanelScrollInput) {
  useEffect(() => {
    const panel = panelRef.current;
    if (panel && typeof panel.scrollIntoView === "function") {
      panel.scrollIntoView({ block: "start" });
    }
  }, [issueId]);

  useEffect(() => {
    if (!scrollToIterations) return;
    const section = iterationsRef.current;
    if (section && typeof section.scrollIntoView === "function") {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    onScrolled();
  }, [scrollToIterations]);
}