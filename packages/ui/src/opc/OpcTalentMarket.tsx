/**
 * zcode-go OPC 人才市场：内置角色模板（OpenOPC 五字段格式）+ 导入模板，
 * 按领域分类展示，一键招聘。支持从磁盘目录批量导入 OpenOPC talent 模板。
 */
import { useMemo, useState } from "react";
import { FolderInput } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  OPC_BUILTIN_ROLE_DRAFTS,
  type OpcCompanyState,
  type OpcRoleTemplateDraft,
} from "@zcode/shared";
import { logger } from "@/logger.js";

/** 导入 frontmatter 的 category 直通非枚举值——非枚举时原样展示而非渲染坏 key。 */
function categoryLabel(
  intl: { formatMessage: (opts: { id: string }) => string },
  category: string,
): string {
  const id = `opc.category.${category}`;
  // react-intl 缺 id 时返回 id 本身；此时回退 general 的文案
  const text = intl.formatMessage({ id });
  return text === id
    ? intl.formatMessage({ id: "opc.category.general" })
    : text;
}

export interface OpcTalentMarketProps {
  state: OpcCompanyState;
  /** 招聘：传模板草稿（内置或导入，含正文供 prompt 构造）。 */
  onHireTemplate: (
    draft: OpcRoleTemplateDraft,
    origin: "builtin" | "imported",
  ) => void;
  onImportFolder: (sourcePath: string) => Promise<void>;
}

const CATEGORY_ORDER = [
  "executive",
  "engineering",
  "design",
  "product",
  "research",
  "finance",
  "sales",
  "marketing",
  "media",
  "operations",
  "education",
  "general",
];

function groupTemplates(
  drafts: Array<
    OpcRoleTemplateDraft & {
      origin: "builtin" | "imported";
      hiredCount: number;
    }
  >,
): Array<[string, typeof drafts]> {
  const grouped = new Map<string, typeof drafts>();
  for (const draft of drafts) {
    const list = grouped.get(draft.category) ?? [];
    list.push(draft);
    grouped.set(draft.category, list);
  }
  return [...grouped.entries()].sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]) ||
      a[0].localeCompare(b[0]),
  );
}

export function OpcTalentMarket({
  state,
  onHireTemplate,
  onImportFolder,
}: OpcTalentMarketProps) {
  const { intl } = useZCodeIntl();
  const [importPath, setImportPath] = useState("");
  const [importing, setImporting] = useState(false);

  const hiredCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const employee of state.employees) {
      counts.set(
        employee.templateId,
        (counts.get(employee.templateId) ?? 0) + 1,
      );
    }
    return counts;
  }, [state.employees]);

  const importedDrafts: Array<
    OpcRoleTemplateDraft & { origin: "imported"; hiredCount: number }
  > = useMemo(
    () =>
      state.roleTemplates.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        color: template.color,
        emoji: template.emoji,
        vibe: template.vibe,
        category: template.category,
        body: "",
        origin: "imported" as const,
        hiredCount: hiredCounts.get(template.id) ?? 0,
      })),
    [state.roleTemplates, hiredCounts],
  );

  const builtinDrafts = useMemo(
    () =>
      OPC_BUILTIN_ROLE_DRAFTS.map((draft) => ({
        ...draft,
        origin: "builtin" as const,
        hiredCount: hiredCounts.get(draft.id) ?? 0,
      })),
    [hiredCounts],
  );

  const allDrafts = useMemo(
    () => [...importedDrafts, ...builtinDrafts],
    [importedDrafts, builtinDrafts],
  );
  const groups = useMemo(() => groupTemplates(allDrafts), [allDrafts]);

  const handleImport = async () => {
    const sourcePath = importPath.trim();
    if (!sourcePath || importing) return;
    setImporting(true);
    try {
      await onImportFolder(sourcePath);
      setImportPath("");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "opc.market.hint" })}
        </p>
        <Input
          value={importPath}
          onChange={(event) => setImportPath(event.target.value)}
          placeholder={intl.formatMessage({
            id: "opc.market.importPlaceholder",
          })}
          className="h-7 max-w-72"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!importPath.trim() || importing}
          onClick={() => {
            void handleImport();
          }}
        >
          <FolderInput className="size-4" />
          {intl.formatMessage({ id: "opc.market.import" })}
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 pb-4">
          {groups.map(([category, drafts]) => (
            <div key={category}>
              <p className="mb-2 text-ui-xs font-medium uppercase tracking-wide text-foreground-faint">
                {categoryLabel(intl, category)}
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {drafts.map((draft) => (
                  <div
                    key={`${draft.origin}-${draft.id}`}
                    className="flex flex-col gap-1.5 rounded-xl border border-card-border bg-card p-3"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-lg leading-none">
                        {draft.emoji}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-ui-sm font-medium text-foreground">
                          {draft.name}
                        </p>
                        {draft.vibe ? (
                          <p className="truncate text-ui-xs text-foreground-faint">
                            「{draft.vibe}」
                          </p>
                        ) : null}
                      </div>
                      {draft.hiredCount > 0 ? (
                        <span className="rounded bg-surface-hover px-1.5 py-0.5 text-ui-xs tabular-nums text-foreground-subtle">
                          ×{draft.hiredCount}
                        </span>
                      ) : null}
                    </div>
                    <p className="line-clamp-2 text-ui-xs text-foreground-subtle">
                      {draft.description}
                    </p>
                    <div className="mt-auto pt-1">
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => {
                          logger.debug("[zcode-go][opc] 招聘", {
                            template: draft.id,
                          });
                          onHireTemplate(draft, draft.origin);
                        }}
                      >
                        {intl.formatMessage({ id: "opc.market.hire" })}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
