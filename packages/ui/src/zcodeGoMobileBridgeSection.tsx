/**
 * zcode-go P2P 直连区（WebRTC 桥）：与官方 relay 远控相互独立的一套配对链路。
 * 从 WebRemoteControlDialog 拆出的独立文件——上游合并零冲突（该弹层的 zcode-go
 * 门控点仅 import + 一行渲染）。挂在官方弹层内容尾部；DialogContent 关闭即卸载
 * → 配对生命周期（开启配对 / 可见性上报 / 关闭收摊）由挂载/卸载自然驱动。
 */
import { memo, useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, Globe, Loader2, RefreshCw, Smartphone, Square } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * zcode-go P2P 直连区（WebRTC 桥）：与官方 relay 远控相互独立的一套配对链路。
 * 挂在官方弹层内容尾部；DialogContent 关闭即卸载 → 配对生命周期
 * （开启配对 / 可见性上报 / 关闭收摊）由挂载/卸载自然驱动。
 */
export const ZcodeGoMobileBridgeSection = memo(function ZcodeGoMobileBridgeSection() {
  const { intl } = useZCodeIntl();
  // 打开对话框即开始配对，关闭即停止；一次性配对码，状态由 main 推送
  // （信令/等待手机/协商/已连接）。
  const [bridgeStatus, setBridgeStatus] = useState<{
    state: "idle" | "signaling" | "waiting-mobile" | "connecting" | "connected" | "error";
    pairingUrl?: string;
    qrUrl?: string;
    token?: string;
    error?: string;
  }>({ state: "idle" });
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // 信令服务器（自部署 Worker 覆盖；空 = 默认官方服务）。
  const [signalingOriginInput, setSignalingOriginInput] = useState("");
  const [signalingOriginEffective, setSignalingOriginEffective] = useState<string | null>(null);
  /** config 中已保存的覆盖值（null = 未配置，用默认服务）。 */
  const [signalingOriginConfigured, setSignalingOriginConfigured] = useState<string | null>(null);
  const [originFeedback, setOriginFeedback] = useState<
    { kind: "saved" } | { kind: "error"; id: string } | null
  >(null);
  const [originApplying, setOriginApplying] = useState(false);
  // 与「已配置值」比较而非生效值：清空已保存的覆盖（恢复默认）也构成变更——
  // 否则按钮禁用，「清空后确认可恢复默认」的提示无法兑现。
  const originDirty =
    signalingOriginInput.trim().replace(/\/$/, "") !== (signalingOriginConfigured ?? "");

  useEffect(() => {
    const bridge = (
      window as {
        zcode?: {
          zcodeGoMobileBridgeStart?: () => Promise<typeof bridgeStatus>;
          zcodeGoMobileBridgeStop?: () => Promise<void>;
          zcodeGoMobileBridgeGetSignalingOrigin?: () => Promise<{
            effective: string;
            configured: string | null;
            source: "env" | "config" | "default";
          }>;
          zcodeGoMobileBridgeSetSignalingOrigin?: (origin: string | null) => Promise<{
            ok: boolean;
            error?: string;
            effective?: string;
          }>;
          onZcodeGoMobileBridgeStatusChanged?: (
            handler: (status: typeof bridgeStatus) => void,
          ) => () => void;
        };
      }
    ).zcode;
    const unsubscribe = bridge?.onZcodeGoMobileBridgeStatusChanged?.((status) => {
      setBridgeStatus(status);
    });
    void bridge?.zcodeGoMobileBridgeStart?.().then((status) => {
      if (status) setBridgeStatus(status);
    });
    void bridge?.zcodeGoMobileBridgeGetSignalingOrigin?.().then((info) => {
      if (!info) return;
      setSignalingOriginEffective(info.effective);
      setSignalingOriginConfigured(info.configured);
      // 已配置自部署地址则回填输入框；默认/env 来源留空（占位符展示生效值）。
      setSignalingOriginInput(info.source === "config" ? (info.configured ?? "") : "");
    });
    // 注意：关闭对话框不立即停止配对（扫码后关窗等手机加载的场景），但会
    // 上报可见性：main 侧无连接时启动短保险丝收摊，有连接则挂起信令——
    // 「安装即用」成本模型：无人使用 = 零信令流量。
    void (
      window as {
        zcode?: { zcodeGoMobileBridgeSetDialogVisible?: (v: boolean) => Promise<void> };
      }
    ).zcode?.zcodeGoMobileBridgeSetDialogVisible?.(true);
    return () => {
      unsubscribe?.();
      void (
        window as {
          zcode?: { zcodeGoMobileBridgeSetDialogVisible?: (v: boolean) => Promise<void> };
        }
      ).zcode?.zcodeGoMobileBridgeSetDialogVisible?.(false);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const qrContent = bridgeStatus.qrUrl ?? bridgeStatus.pairingUrl;
    if (!qrContent) {
      setQrDataUrl(null);
      return;
    }
    // width 640 显示时缩到 size-80（2:1 高分屏仍清晰）；margin 4 为 QR 规范
    // 静区——此前 margin 1 + 大 payload 过密，相机扫不出。静区已内嵌在图片
    // 白边里，显示侧不再叠加 padding（否则留白观感翻倍）。
    void QRCode.toDataURL(qrContent, { margin: 4, width: 640 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bridgeStatus.qrUrl, bridgeStatus.pairingUrl]);

  // 状态 → 官方文案/色点映射（status/statusDetail 与官方 key 一致）。
  const bridgeStatusLabelId = (() => {
    switch (bridgeStatus.state) {
      case "signaling":
        return "webRemoteControl.status.starting";
      case "waiting-mobile":
        return "webRemoteControl.status.running";
      case "connecting":
        return "webRemoteControl.status.connecting";
      case "connected":
        return "webRemoteControl.status.active";
      case "error":
        return "webRemoteControl.status.error";
      default:
        return "webRemoteControl.status.idle";
    }
  })();
  const bridgeStatusDetailId = (() => {
    switch (bridgeStatus.state) {
      case "signaling":
        return "webRemoteControl.statusDetail.starting";
      case "waiting-mobile":
        return "webRemoteControl.statusDetail.running";
      case "connecting":
        return "webRemoteControl.statusDetail.connecting";
      case "connected":
        return "webRemoteControl.statusDetail.active";
      case "error":
        return "webRemoteControl.statusDetail.error";
      default:
        return "webRemoteControl.statusDetail.idle";
    }
  })();
  const bridgeStatusDotClass = (() => {
    switch (bridgeStatus.state) {
      case "connected":
        return "bg-emerald-500";
      case "signaling":
      case "waiting-mobile":
      case "connecting":
        return "bg-amber-500";
      case "error":
        return "bg-destructive";
      default:
        return "bg-foreground-subtle/40";
    }
  })();
  const bridgeBusy =
    bridgeStatus.state === "signaling" ||
    bridgeStatus.state === "waiting-mobile" ||
    bridgeStatus.state === "connecting";

  const handleStopPairing = useCallback(() => {
    const bridge = (
      window as {
        zcode?: { zcodeGoMobileBridgeStop?: () => Promise<void> };
      }
    ).zcode;
    void bridge?.zcodeGoMobileBridgeStop?.();
  }, []);

  const [copiedLink, setCopiedLink] = useState(false);
  const handleCopyBridgeLink = useCallback(() => {
    const url = bridgeStatus.pairingUrl;
    if (!url) return;
    void navigator.clipboard.writeText(url).then(
      () => {
        setCopiedLink(true);
        window.setTimeout(() => setCopiedLink(false), 2000);
      },
      (error) => {
        logger.warn("[WebRemoteControlDialog] 复制远程控制链接失败", error);
      },
    );
  }, [bridgeStatus.pairingUrl]);

  const handleRefreshPairing = useCallback(() => {
    const bridge = (
      window as {
        zcode?: {
          zcodeGoMobileBridgeStop?: () => Promise<void>;
          zcodeGoMobileBridgeStart?: () => Promise<typeof bridgeStatus>;
        };
      }
    ).zcode;
    void bridge?.zcodeGoMobileBridgeStop?.().then(() => {
      return bridge?.zcodeGoMobileBridgeStart?.();
    });
  }, []);

  // 确认变更信令服务器：写配置（清空 = 恢复默认）；main 侧有活跃会话时重建，
  // 新二维码经状态事件自动回流。校验在 main 权威重复一次（invalid_url 等）。
  const handleApplySignalingOrigin = useCallback(() => {
    const bridge = (
      window as {
        zcode?: {
          zcodeGoMobileBridgeGetSignalingOrigin?: () => Promise<{
            effective: string;
            configured: string | null;
            source: "env" | "config" | "default";
          }>;
          zcodeGoMobileBridgeSetSignalingOrigin?: (origin: string | null) => Promise<{
            ok: boolean;
            error?: string;
            effective?: string;
          }>;
        };
      }
    ).zcode;
    const value = signalingOriginInput.trim();
    setOriginApplying(true);
    setOriginFeedback(null);
    void bridge?.zcodeGoMobileBridgeSetSignalingOrigin?.(value || null)
      .then((result) => {
        if (!result) return;
        if (result.ok) {
          setSignalingOriginEffective(result.effective ?? null);
          // 回填以权威 Get 为准（避免 UI 硬编码默认域名与主进程常量漂移）。
          void bridge?.zcodeGoMobileBridgeGetSignalingOrigin?.().then((info) => {
            if (!info) return;
            setSignalingOriginEffective(info.effective);
            setSignalingOriginConfigured(info.configured);
            setSignalingOriginInput(info.source === "config" ? (info.configured ?? "") : "");
          });
          setOriginFeedback(
            result.error === "overridden-by-env"
              ? { kind: "error", id: "zcodeGoMobileBridge.signalingOrigin.envOverride" }
              : { kind: "saved" },
          );
        } else {
          setOriginFeedback({
            kind: "error",
            id: result.error?.startsWith("config_write_failed")
              ? "zcodeGoMobileBridge.signalingOrigin.saveFailed"
              : "zcodeGoMobileBridge.signalingOrigin.invalidUrl",
          });
        }
      })
      .catch(() => {
        setOriginFeedback({ kind: "error", id: "zcodeGoMobileBridge.signalingOrigin.saveFailed" });
      })
      .finally(() => setOriginApplying(false));
  }, [signalingOriginInput]);

  return (
    <section
      data-testid="web-remote-control-scan-card"
      className="mt-4 flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4"
    >
      {/* 自部署信令服务器：输入 + 确认（写配置并刷新二维码），下方
          分隔符隔开官方扫码区。 */}
      <div className="mb-3" data-testid="web-remote-control-signaling-origin">
        <div className="flex flex-wrap items-center gap-2">
          <Globe className="size-4 shrink-0 text-foreground-subtle" />
          <Input
            value={signalingOriginInput}
            onChange={(event) => {
              setSignalingOriginInput(event.target.value);
              setOriginFeedback(null);
            }}
            placeholder={signalingOriginEffective ?? "https://zcode-go.aimon.win"}
            spellCheck={false}
            className="h-8 min-w-56 flex-1 font-mono text-ui-base"
            aria-label={intl.formatMessage({
              id: "zcodeGoMobileBridge.signalingOrigin.title",
            })}
          />
          <Button
            type="button"
            variant="outline"
            size="default"
            className="shrink-0 gap-2 enabled:cursor-pointer"
            onClick={handleApplySignalingOrigin}
            disabled={!originDirty || originApplying}
          >
            {originApplying ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            {intl.formatMessage({
              id: "zcodeGoMobileBridge.signalingOrigin.apply",
            })}
          </Button>
        </div>
        <p
          className={`mt-1.5 text-ui-xs ${
            originFeedback?.kind === "error" ? "text-destructive" : "text-foreground-subtle"
          }`}
        >
          {originFeedback?.kind === "saved"
            ? intl.formatMessage({
                id: "zcodeGoMobileBridge.signalingOrigin.applied",
              })
            : originFeedback?.kind === "error"
              ? intl.formatMessage({ id: originFeedback.id })
              : intl.formatMessage({
                  id: "zcodeGoMobileBridge.signalingOrigin.description",
                })}
        </p>
      </div>
      <div className="mb-4 border-t border-border" />
      <div className="mb-4 flex items-start gap-2">
        <Smartphone className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
        <div className="min-w-0 space-y-1">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "webRemoteControl.mobileQr.title" })}
          </div>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "webRemoteControl.mobileQr.description" })}
          </p>
        </div>
      </div>
      <div
        data-testid="web-remote-control-connection-card"
        className="mb-3 rounded-lg bg-surface px-3 py-2"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: bridgeStatusLabelId })}
              </div>
              <div className="flex min-w-0 items-center gap-1.5 rounded-full bg-card px-2 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                <span className={`size-1.5 shrink-0 rounded-full ${bridgeStatusDotClass}`} />
                <span className="truncate">
                  {intl.formatMessage({
                    id:
                      bridgeStatus.state === "connected"
                        ? "webRemoteControl.statusTag.phone"
                        : "webRemoteControl.statusTag.ready",
                  })}
                </span>
              </div>
            </div>
            <div className="text-ui-base/relaxed text-foreground-subtle">
              {intl.formatMessage({ id: bridgeStatusDetailId })}
            </div>
          </div>
          {bridgeBusy ? (
            <Loader2 className="size-4 animate-spin text-foreground-subtle" />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="default"
              className="shrink-0 gap-2 enabled:cursor-pointer"
              onClick={handleStopPairing}
              disabled={bridgeStatus.state === "idle"}
            >
              <Square className="size-3.5" />
              {intl.formatMessage({ id: "webRemoteControl.stop" })}
            </Button>
          )}
        </div>
        {bridgeStatus.state === "error" ? (
          <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-ui-base/relaxed text-destructive">
            <p>{bridgeStatus.error}</p>
          </div>
        ) : null}
      </div>
      <div
        data-testid="web-remote-control-copy-link-row"
        className="mt-3 flex min-h-10 flex-wrap items-center gap-3 border-t border-border pt-3"
      >
        <div className="min-w-48 flex-1 text-ui-base/relaxed text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.copyLink.description" })}
        </div>
        <Button
          type="button"
          variant="outline"
          size="default"
          className="shrink-0 gap-2 enabled:cursor-pointer"
          onClick={handleRefreshPairing}
          disabled={bridgeBusy}
        >
          <RefreshCw className="size-3.5" />
          {/* 桥区独立文案：官方 relay 刷新按钮同名会让上游布局测试的 name 查询歧义 */}
          {intl.formatMessage({ id: "zcodeGoMobileBridge.refresh" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="default"
          className="shrink-0 gap-2 enabled:cursor-pointer"
          onClick={handleCopyBridgeLink}
          disabled={!bridgeStatus.pairingUrl}
        >
          {copiedLink ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {intl.formatMessage({
            id: copiedLink
              ? "zcodeGoMobileBridge.copyLink.copied"
              : "webRemoteControl.copyLink",
          })}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-background-alt p-4">
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt={intl.formatMessage({ id: "webRemoteControl.qrAlt" })}
            className="size-80 max-w-full rounded-lg bg-white"
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-center text-ui-base text-foreground-subtle">
            <Loader2 className="size-5 animate-spin" />
            <span>{intl.formatMessage({ id: "webRemoteControl.generating" })}</span>
          </div>
        )}
      </div>
    </section>
  );
});
