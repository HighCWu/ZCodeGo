/**
 * zcode-go OPC 升级对话框（OpenOPC「先团队内解决，超权限才升级所有者」）：
 * 上半区给出同类目转派候选（按完成数排序），下半区升级给所有者（可附说明）。
 */
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Label } from "@/components/ui/label.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  findOpcEscalationCandidates,
  type OpcCompanyState,
  type OpcMutation,
  type OpcWorkItem,
} from "@zcode/shared";

export function OpcEscalateDialog({
  state,
  workItem,
  onClose,
  onSubmit,
}: {
  state: OpcCompanyState;
  workItem: OpcWorkItem;
  onClose: () => void;
  onSubmit: (mutations: OpcMutation[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const [note, setNote] = useState("");
  const candidates = findOpcEscalationCandidates(state, workItem);

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "opc.escalate.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "opc.escalate.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>
              {intl.formatMessage({ id: "opc.escalate.routeTitle" })}
            </Label>
            {candidates.length === 0 ? (
              <p className="text-ui-xs text-foreground-faint">
                {intl.formatMessage({ id: "opc.escalate.noCandidates" })}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {candidates.map((candidate) => (
                  <Button
                    key={candidate.employeeId}
                    size="sm"
                    variant="outline"
                    className="justify-start"
                    onClick={() => {
                      onSubmit([
                        {
                          kind: "workitem.transfer",
                          workItemId: workItem.id,
                          toEmployeeId: candidate.employeeId,
                          note: intl.formatMessage({
                            id: "opc.escalate.transferNote",
                          }),
                        },
                      ]);
                      onClose();
                    }}
                  >
                    {candidate.emoji} {candidate.name}
                    <span className="ml-auto text-ui-xs text-foreground-faint">
                      {intl.formatMessage(
                        {
                          id:
                            candidate.reason === "peer-category"
                              ? "opc.escalate.peer"
                              : candidate.reason === "direct-manager"
                                ? "opc.escalate.manager"
                                : "opc.escalate.top",
                        },
                        { completed: candidate.completed },
                      )}
                    </span>
                  </Button>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-escalate-note">
              {intl.formatMessage({ id: "opc.escalate.ownerNote" })}
            </Label>
            <Textarea
              id="opc-escalate-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder={intl.formatMessage({
                id: "opc.escalate.notePlaceholder",
              })}
            />
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                onSubmit([
                  {
                    kind: "workitem.escalate",
                    workItemId: workItem.id,
                    note: note.trim() || undefined,
                  },
                ]);
                onClose();
              }}
            >
              {intl.formatMessage({ id: "opc.escalate.toOwner" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
