/**
 * zcode-go 设置板块（新文件——上游合并门控点 = settingsPageConfig 条目 +
 * SettingsPage 的 import/render 两行）。四个功能开关，全部默认启用：
 *   - P2P 直连远程桥（关闭后远程弹层仅保留官方 relay 入口）
 *   - hover fork 双会话模型（关闭后手动 fork 走兼容轮换模型）
 *   - 移动端抽屉视口（关闭后手机视口按桌面布局渲染）
 *   - UI 崩溃自动恢复（关闭后错误边界仅提供手动恢复按钮）
 */
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { Switch } from "@/components/ui/switch.js";

type ZcodeGoSettingKey =
  | "zcodeGoP2pMobileBridge"
  | "zcodeGoHoverForkDualSession"
  | "zcodeGoMobileDrawerViewport"
  | "zcodeGoUiAutoRecovery";

export function ZcodeGoSettingsSection() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();

  // 显式键→值映射（AppSettings 无索引签名，避免泛型键访问）
  const values: Record<ZcodeGoSettingKey, boolean> = {
    zcodeGoP2pMobileBridge: settings?.zcodeGoP2pMobileBridge !== false,
    zcodeGoHoverForkDualSession: settings?.zcodeGoHoverForkDualSession !== false,
    zcodeGoMobileDrawerViewport: settings?.zcodeGoMobileDrawerViewport !== false,
    zcodeGoUiAutoRecovery: settings?.zcodeGoUiAutoRecovery !== false,
  };

  const toggleRows: Array<{
    key: ZcodeGoSettingKey;
    labelId: string;
    descriptionId: string;
  }> = [
    {
      key: "zcodeGoP2pMobileBridge",
      labelId: "settings.zcodeGo.p2pBridge",
      descriptionId: "settings.zcodeGo.p2pBridgeDescription",
    },
    {
      key: "zcodeGoHoverForkDualSession",
      labelId: "settings.zcodeGo.hoverForkDualSession",
      descriptionId: "settings.zcodeGo.hoverForkDualSessionDescription",
    },
    {
      key: "zcodeGoMobileDrawerViewport",
      labelId: "settings.zcodeGo.mobileDrawer",
      descriptionId: "settings.zcodeGo.mobileDrawerDescription",
    },
    {
      key: "zcodeGoUiAutoRecovery",
      labelId: "settings.zcodeGo.uiAutoRecovery",
      descriptionId: "settings.zcodeGo.uiAutoRecoveryDescription",
    },
  ];

  return (
    <div className="space-y-4">
      {toggleRows.map(({ key, labelId, descriptionId }) => {
        const enabled = values[key];
        return (
          <SettingsGroupCard key={key}>
            <SettingsRow
              label={intl.formatMessage({ id: labelId })}
              description={intl.formatMessage({ id: descriptionId })}
              control={
                <Switch
                  aria-label={intl.formatMessage({ id: labelId })}
                  checked={enabled}
                  onCheckedChange={(checked) => {
                    void update({ [key]: checked });
                  }}
                />
              }
            />
          </SettingsGroupCard>
        );
      })}
    </div>
  );
}
