/**
 * zcode-go OPC 组织智能对话框：「按目标生成架构」（agent 产出 opc-org 围栏 JSON，
 * 解析预览后一键应用）与「架构预设」（内置 corporate/engineering/flat 一键应用）。
 * 从 OpcOrgView 入口进入；全部写路径经 apply(mutations) 收口。
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Label } from "@/components/ui/label.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpcStore } from "@/store/opcStore.js";
import {
  buildOpcOrgGeneratePrompt,
  buildOpcOrgMutations,
  OPC_ORG_PRESETS,
  parseOpcOrgBlock,
  type OpcOrgDraft,
} from "@zcode/shared";
import { insertOpcPrompt } from "./opcComposerBridge.js";

/** 解析预览（生成/预设共用）：岗位与招聘清单。 */
function OpcOrgDraftPreview({ draft }: { draft: OpcOrgDraft }) {
  return (
    <div className="rounded-lg border border-card-border bg-surface p-2 text-ui-xs">
      {draft.companyName ? (
        <p className="mb-1 text-foreground">公司名：{draft.companyName}</p>
      ) : null}
      {draft.slots.length > 0 ? (
        <p className="text-foreground-subtle">岗位：{draft.slots.join("、")}</p>
      ) : null}
      <ul className="mt-1 space-y-0.5">
        {draft.hires.map((hire) => (
          <li
            key={`${hire.name}-${hire.slot ?? ""}`}
            className="text-foreground-subtle"
          >
            · {hire.name}
            {hire.template ? `（${hire.template}）` : ""}
            {hire.slot ? ` → ${hire.slot}` : ""}
            {hire.seniority ? ` / ${hire.seniority}` : ""}
          </li>
        ))}
      </ul>
      {draft.slots.length === 0 && draft.hires.length === 0 ? (
        <p className="text-foreground-faint">（空架构：仅调整公司名）</p>
      ) : null}
    </div>
  );
}

export function OpcOrgGenerateDialog({
  onClose,
  workspaceIdentity,
}: {
  onClose: () => void;
  workspaceIdentity?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const apply = useOpcStore((s) => s.apply);
  const state = useOpcStore((s) => s.state);
  const workspacePath = useOpcStore((s) => s.workspacePath);
  const [goal, setGoal] = useState("");
  const [output, setOutput] = useState("");
  const parsed = useMemo(() => parseOpcOrgBlock(output), [output]);
  const outcome = useMemo(
    () =>
      state && parsed ? buildOpcOrgMutations(state, parsed, Date.now()) : null,
    [state, parsed],
  );

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "opc.org.generateTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "opc.org.generateDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-org-goal">
              {intl.formatMessage({ id: "opc.org.goalLabel" })}
            </Label>
            <Textarea
              id="opc-org-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={2}
              placeholder={intl.formatMessage({
                id: "opc.org.goalPlaceholder",
              })}
            />
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              disabled={!goal.trim() || !workspacePath}
              onClick={() => {
                if (!workspacePath) return;
                insertOpcPrompt({
                  workspacePath,
                  workspaceIdentity: workspaceIdentity ?? undefined,
                  text: buildOpcOrgGeneratePrompt({ goal }),
                });
              }}
            >
              {intl.formatMessage({ id: "opc.org.generatePrompt" })}
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-org-output">
              {intl.formatMessage({ id: "opc.org.outputLabel" })}
            </Label>
            <Textarea
              id="opc-org-output"
              value={output}
              onChange={(event) => setOutput(event.target.value)}
              rows={6}
              placeholder={intl.formatMessage({
                id: "opc.org.outputPlaceholder",
              })}
            />
            {output.trim() && !parsed ? (
              <p className="text-ui-xs text-destructive">
                {intl.formatMessage({ id: "opc.org.parseFailed" })}
              </p>
            ) : null}
            {parsed && outcome ? (
              <>
                <OpcOrgDraftPreview draft={parsed} />
                <p className="text-ui-xs text-foreground-faint">
                  {intl.formatMessage(
                    { id: "opc.org.parsed" },
                    {
                      slots: outcome.summary.slots,
                      hires: outcome.summary.hires,
                      reused: outcome.summary.reused,
                      skipped: outcome.summary.skipped,
                    },
                  )}
                </p>
              </>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {intl.formatMessage({ id: "opc.common.cancel" })}
          </Button>
          <Button
            size="sm"
            disabled={!parsed || !outcome || outcome.mutations.length === 0}
            onClick={() => {
              if (!parsed || !outcome) return;
              void apply(outcome.mutations);
              onClose();
            }}
          >
            {intl.formatMessage({ id: "opc.org.apply" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OpcOrgPresetDialog({ onClose }: { onClose: () => void }) {
  const { intl } = useZCodeIntl();
  const apply = useOpcStore((s) => s.apply);
  const state = useOpcStore((s) => s.state);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    OPC_ORG_PRESETS.find((preset) => preset.id === selectedId) ?? null;
  const outcome = useMemo(
    () =>
      state && selected
        ? buildOpcOrgMutations(state, selected.draft, Date.now())
        : null,
    [state, selected],
  );

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "opc.org.presetTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "opc.org.presetDescription" })}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-64">
          <div className="flex flex-col gap-2">
            {OPC_ORG_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                variant={selectedId === preset.id ? "secondary" : "outline"}
                className="h-auto flex-col items-start gap-0.5 py-2 text-left"
                onClick={() => setSelectedId(preset.id)}
              >
                <span className="text-ui-sm font-medium">{preset.title}</span>
                <span className="text-ui-xs font-normal text-foreground-subtle">
                  {preset.description}
                </span>
              </Button>
            ))}
          </div>
        </ScrollArea>
        {selected && outcome ? (
          <div className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              { id: "opc.org.presetSummary" },
              {
                slots: outcome.summary.slots,
                hires: outcome.summary.hires,
                reused: outcome.summary.reused,
                skipped: outcome.summary.skipped,
              },
            )}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {intl.formatMessage({ id: "opc.common.cancel" })}
          </Button>
          <Button
            size="sm"
            disabled={!selected || !outcome || outcome.mutations.length === 0}
            onClick={() => {
              if (!outcome) return;
              void apply(outcome.mutations);
              onClose();
            }}
          >
            {intl.formatMessage({ id: "opc.org.apply" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
