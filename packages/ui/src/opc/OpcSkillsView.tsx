/**
 * zcode-go OPC 技能库视图：内置/导入/晋升三类技能，版本与变更记录可见，
 * 支持挂接员工、发起自主迭代升级、从磁盘导入 claude-skills 风格技能目录。
 */
import { useMemo, useState } from "react";
import { FolderInput, ArrowUpCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpcCompanyState } from "@zcode/shared";

export interface OpcSkillsViewProps {
  state: OpcCompanyState;
  onUpgrade: (skillId: string) => void;
  onToggleAttach: (
    employeeId: string,
    skillId: string,
    attach: boolean,
  ) => void;
  onImportFolder: (sourcePath: string) => Promise<void>;
}

const ORIGIN_MESSAGE_ID: Record<string, string> = {
  builtin: "opc.skills.originBuiltin",
  imported: "opc.skills.originImported",
  promoted: "opc.skills.originPromoted",
};

export function OpcSkillsView({
  state,
  onUpgrade,
  onToggleAttach,
  onImportFolder,
}: OpcSkillsViewProps) {
  const { intl } = useZCodeIntl();
  const [importPath, setImportPath] = useState("");
  const [importing, setImporting] = useState(false);
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null);

  const employees = useMemo(
    () => state.employees.filter((employee) => employee.status !== "departed"),
    [state.employees],
  );
  const skills = useMemo(
    () => [...state.skills].sort((a, b) => b.updatedAt - a.updatedAt),
    [state.skills],
  );

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
          {intl.formatMessage({ id: "opc.skills.hint" })}
        </p>
        <Input
          value={importPath}
          onChange={(event) => setImportPath(event.target.value)}
          placeholder={intl.formatMessage({
            id: "opc.skills.importPlaceholder",
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
          {intl.formatMessage({ id: "opc.skills.import" })}
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2.5 pb-4">
          {skills.map((skill) => {
            const expanded = expandedSkillId === skill.id;
            const attachedEmployees = employees.filter((employee) =>
              employee.skillRefs.includes(skill.id),
            );
            return (
              <div
                key={skill.id}
                className="rounded-xl border border-card-border bg-card p-3"
              >
                <div className="flex items-start gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-ui-sm font-medium text-foreground">
                        {skill.name}
                      </p>
                      <span className="rounded bg-surface-hover px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                        v{skill.version}
                      </span>
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-ui-xs text-primary">
                        {intl.formatMessage({
                          id:
                            ORIGIN_MESSAGE_ID[skill.origin] ??
                            "opc.skills.originBuiltin",
                        })}
                      </span>
                      <span className="text-ui-xs text-foreground-faint">
                        {intl.formatMessage({
                          id: `opc.category.${skill.category}`,
                        })}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-ui-xs text-foreground-subtle">
                      {skill.description}
                    </p>
                    {skill.changelog.length > 0 ? (
                      <p className="mt-1 line-clamp-1 text-ui-xs text-foreground-faint">
                        {skill.changelog[skill.changelog.length - 1]}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => onUpgrade(skill.id)}
                  >
                    <ArrowUpCircle className="size-3" />
                    {intl.formatMessage({ id: "opc.skills.upgrade" })}
                  </Button>
                </div>
                {expanded ? (
                  <div className="mt-3 border-t border-card-border pt-2.5">
                    <p className="mb-1.5 text-ui-xs text-foreground-faint">
                      {intl.formatMessage({ id: "opc.skills.changelog" })}
                    </p>
                    <ul className="mb-2.5 space-y-0.5">
                      {[...skill.changelog].reverse().map((line) => (
                        <li
                          key={line}
                          className="text-ui-xs text-foreground-subtle"
                        >
                          · {line}
                        </li>
                      ))}
                    </ul>
                    <p className="mb-1.5 text-ui-xs text-foreground-faint">
                      {intl.formatMessage({ id: "opc.skills.attachTitle" })}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {employees.map((employee) => {
                        const attached = employee.skillRefs.includes(skill.id);
                        return (
                          <Button
                            key={employee.id}
                            size="xs"
                            variant={attached ? "secondary" : "ghost"}
                            onClick={() =>
                              onToggleAttach(employee.id, skill.id, !attached)
                            }
                          >
                            {employee.emoji} {employee.name}
                            {attached ? " ✓" : ""}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-foreground-faint"
                    onClick={() =>
                      setExpandedSkillId(expanded ? null : skill.id)
                    }
                  >
                    {expanded
                      ? intl.formatMessage({ id: "opc.skills.collapse" })
                      : intl.formatMessage({ id: "opc.skills.expand" })}
                  </Button>
                  {attachedEmployees.length > 0 ? (
                    <span className="text-ui-xs text-foreground-faint">
                      {intl.formatMessage(
                        { id: "opc.skills.attachedCount" },
                        { count: attachedEmployees.length },
                      )}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
