/**
 * zcode-go OPC 看板（吸收 OpenOPC WorkItem 状态机：backlog→ready→in_progress→review→done）。
 * 状态推进按钮由共享 reducer 的流转表驱动（非法流转不渲染按钮）。
 */
import { useMemo } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  OPC_WORK_ITEM_TRANSITIONS,
  type OpcCompanyState,
  type OpcWorkItem,
  type OpcWorkItemStatus,
} from "@zcode/shared";
import {
  OpcEmployeeAvatar,
  OpcPriorityBadge,
  OPC_WORK_ITEM_STATUSES,
  opcStatusMessageId,
  OpcStatusBadge,
} from "./opcDisplay.js";

export interface OpcKanbanBoardProps {
  state: OpcCompanyState;
  onCreateWorkItem: () => void;
  onEditWorkItem: (workItem: OpcWorkItem) => void;
  onStatusChange: (workItemId: string, status: OpcWorkItemStatus) => void;
  onDeleteWorkItem: (workItemId: string) => void;
  onDelegate: (workItem: OpcWorkItem) => void;
}

export function OpcKanbanBoard({
  state,
  onCreateWorkItem,
  onEditWorkItem,
  onStatusChange,
  onDeleteWorkItem,
  onDelegate,
}: OpcKanbanBoardProps) {
  const { intl } = useZCodeIntl();
  const employeesById = useMemo(
    () => new Map(state.employees.map((employee) => [employee.id, employee])),
    [state.employees],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "opc.kanban.hint" })}
        </p>
        <Button size="sm" onClick={onCreateWorkItem}>
          <Plus className="size-4" />
          {intl.formatMessage({ id: "opc.kanban.create" })}
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {OPC_WORK_ITEM_STATUSES.map((status) => {
          const items = state.workItems.filter(
            (item) => item.status === status,
          );
          return (
            <div
              key={status}
              className="flex min-h-0 flex-col rounded-xl border border-card-border bg-surface"
            >
              <div className="flex items-center justify-between border-b border-card-border px-3 py-2">
                <span className="text-ui-sm font-medium text-foreground">
                  {intl.formatMessage({ id: opcStatusMessageId(status) })}
                </span>
                <span className="text-ui-xs tabular-nums text-foreground-faint">
                  {items.length}
                </span>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-2 p-2">
                  {items.map((item) => {
                    const assignee = item.assigneeId
                      ? (employeesById.get(item.assigneeId) ?? null)
                      : null;
                    const transitions = OPC_WORK_ITEM_TRANSITIONS[
                      item.status
                    ].filter((next) => next !== "cancelled");
                    return (
                      <div
                        key={item.id}
                        className="group rounded-lg border border-card-border bg-card p-2.5 shadow-xs transition-colors hover:border-border-hover"
                      >
                        <button
                          type="button"
                          className="w-full text-left"
                          onClick={() => onEditWorkItem(item)}
                        >
                          <p className="line-clamp-2 text-ui-sm font-medium text-foreground">
                            {item.title}
                          </p>
                        </button>
                        <div className="mt-2 flex items-center gap-1.5">
                          <OpcPriorityBadge priority={item.priority} />
                          {item.status !== "done" ? (
                            <OpcStatusBadge status={item.status} />
                          ) : null}
                        </div>
                        <div className="mt-2 flex items-center justify-between">
                          <OpcEmployeeAvatar employee={assignee} />
                          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            {assignee &&
                            item.status !== "done" &&
                            item.status !== "cancelled" ? (
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => onDelegate(item)}
                                title={intl.formatMessage({
                                  id: "opc.kanban.delegate",
                                })}
                              >
                                {intl.formatMessage({
                                  id: "opc.kanban.delegate",
                                })}
                              </Button>
                            ) : null}
                            {transitions.map((next) => (
                              <Button
                                key={next}
                                size="xs"
                                variant="ghost"
                                onClick={() => onStatusChange(item.id, next)}
                              >
                                →
                                {intl.formatMessage({
                                  id: opcStatusMessageId(next),
                                })}
                              </Button>
                            ))}
                            {item.status !== "done" ? (
                              <Button
                                size="xs"
                                variant="ghost"
                                className="text-foreground-faint"
                                onClick={() => onDeleteWorkItem(item.id)}
                              >
                                ✕
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {items.length === 0 ? (
                    <p className="px-1 py-4 text-center text-ui-xs text-foreground-faint">
                      —
                    </p>
                  ) : null}
                </div>
              </ScrollArea>
            </div>
          );
        })}
      </div>
    </div>
  );
}
