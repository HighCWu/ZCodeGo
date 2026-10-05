import { useEffect, useState } from "react";

/**
 * 视口宽度分层（对齐官方 remote 的移动适配语义）：
 * <768 移动（侧栏抽屉化、输入法相关行为切换）；<1024 平板；其余桌面。
 */
export type ViewportTier = "mobile" | "tablet" | "desktop";

const MOBILE_MAX_WIDTH_PX = 768;
const TABLET_MAX_WIDTH_PX = 1024;

function computeViewportTier(): ViewportTier {
  if (typeof window === "undefined") return "desktop";
  const width = window.innerWidth;
  if (width < MOBILE_MAX_WIDTH_PX) return "mobile";
  if (width < TABLET_MAX_WIDTH_PX) return "tablet";
  return "desktop";
}

export function useViewportTier(): ViewportTier {
  const [tier, setTier] = useState<ViewportTier>(computeViewportTier);
  useEffect(() => {
    const onChange = () => setTier(computeViewportTier());
    window.addEventListener("resize", onChange);
    return () => window.removeEventListener("resize", onChange);
  }, []);
  return tier;
}

export function useIsMobileViewport(): boolean {
  return useViewportTier() === "mobile";
}
