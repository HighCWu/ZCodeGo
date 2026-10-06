import { ArrowLeft, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveTheme, useTheme, type Theme } from "@/useTheme.js";

/**
 * 移动视口会话页头部（对齐官方 web-remote mobileShell 的 chat 页结构）：
 * `h-11 px-2` 一行 = 返回任务首页（ArrowLeft）+ 静态标题「任务会话」+ 主题菜单。
 * 桌面 WorkspaceHeader 的路径/状态/IDE 等操作在移动端不出现，返回首页是
 * 唯一导航出口；标题不随任务变化，与官方一致（任务名在首页列表可见）。
 */
export function MobileChatHeader({ onBackHome }: { onBackHome: () => void }) {
  const { intl } = useZCodeIntl();
  const { theme, setTheme } = useTheme();
  const themeOptions: { value: Theme; label: string }[] = [
    { value: "zai-light", label: intl.formatMessage({ id: "settings.themeMode.light" }) },
    { value: "zai-dark", label: intl.formatMessage({ id: "settings.themeMode.dark" }) },
    { value: "system", label: intl.formatMessage({ id: "settings.themeMode.system" }) },
  ];
  const isDark = resolveTheme(theme) === "dark";

  return (
    <header
      data-mobile-page="chat"
      className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-header px-2"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={intl.formatMessage({ id: "zcodeGoMobile.backHome" })}
        onClick={onBackHome}
      >
        <ArrowLeft className="size-4" />
      </Button>
      <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
        {intl.formatMessage({ id: "zcodeGoMobile.chatTitle" })}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "zcodeGoMobile.themeMenu" })}
          >
            {isDark ? <Moon className="size-4" /> : <Sun className="size-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {themeOptions.map((option) => (
            <DropdownMenuItem
              key={option.value}
              aria-checked={theme === option.value}
              onSelect={() => setTheme(option.value)}
            >
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
