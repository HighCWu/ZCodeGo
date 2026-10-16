/**
 * zcode-go OPC 看板（吸收 OpenOPC WorkItem 状态机：backlog→ready→in_progress→review→done）。
 * 状态推进按钮由共享 reducer 的流转表驱动（非法流转不渲染按钮）；
 * Self-Run 管理动作齐备：依赖就绪门控（🔒）、委派、审查（通过/退回返工）、
 * 升级上报（escalation）与所有者接手、完成产出的下游整合（integrate）。
 */
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isOpcWorkItemRunnable,
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
  /** 升级上报（打开对话框：先团队内路由，后所有者）。 */
  onEscalate: (workItem: OpcWorkItem) => void;
  /** 解除升级；takeover = 所有者接手（转派创始人）。 */
  onResolveEscalation: (
    workItemId: string,
    action: "resume" | "takeover",
  ) => void;
  /** review 退回返工（打开意见对话框）。 */
  onRework: (workItem: OpcWorkItem) => void;
  /** done 且有被依赖项 → 生成整合 prompt 注入 composer。 */
  onIntegrate: (workItem: OpcWorkItem) => void;
  /** 入站队列（渠道中立 ingest）打开审批对话框。 */
  onOpenInbox: () => void;
  inboxCount: number;
}

export function OpcKanbanBoard({
  state,
  onCreateWorkItem,
  onEditWorkItem,
  onStatusChange,
  onDeleteWorkItem,
  onDelegate,
  onEscalate,
  onResolveEscalation,
  onRework,
  onIntegrate,
  onOpenInbox,
  inboxCount,
}: OpcKanbanBoardProps) {
  const { intl } = useZCodeIntl();
  const [escalationFilter, setEscalationFilter] = useState(false);
  const employeesById = useMemo(
    () => new Map(state.employees.map((employee) => [employee.id, employee])),
    [state.employees],
  );
  const escalationCount = state.workItems.filter(
    (item) => item.escalatedAt,
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "opc.kanban.hint" })}
          </p>
          {escalationCount > 0 ? (
            <Button
              size="xs"
              variant={escalationFilter ? "default" : "outline"}
              onClick={() => setEscalationFilter((current) => !current)}
            >
              ⬆{" "}
              {intl.formatMessage(
                { id: "opc.kanban.escalationFilter" },
                { count: escalationCount },
              )}
            </Button>
          ) : null}
          {inboxCount > 0 ? (
            <Button size="xs" variant="outline" onClick={onOpenInbox}>
              📥{" "}
              {intl.formatMessage(
                { id: "opc.kanban.inboxFilter" },
                { count: inboxCount },
              )}
            </Button>
          ) : null}
        </div>
        <Button size="sm" onClick={onCreateWorkItem}>
          <Plus className="size-4" />
          {intl.formatMessage({ id: "opc.kanban.create" })}
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {OPC_WORK_ITEM_STATUSES.map((status) => {
          const items = state.workItems.filter(
            (item) =>
              item.status === status && (!escalationFilter || item.escalatedAt),
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
                    const runnable = isOpcWorkItemRunnable(
                      item,
                      state.workItems,
                    );
                    const unresolvedDeps = item.dependsOn
                      .map((depId) =>
                        state.workItems.find((dep) => dep.id === depId),
                      )
                      .filter(
                        (dep): dep is OpcWorkItem =>
                          dep !== undefined &&
                          dep.status !== "done" &&
                          dep.status !== "cancelled",
                      );
                    const dependents = state.workItems.filter((dep) =>
                      dep.dependsOn.includes(item.id),
                    );
                    const canDelegate =
                      assignee !== null &&
                      // spec「委派按钮同规则门控」：仅 ready（runnable 已含依赖门控）。
                      // 此前放行 backlog，委派只注入 prompt 不改状态 → 「派发即开跑」不成立
                      item.status === "ready" &&
                      runnable;
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
                            {item.escalatedAt ? "⬆ " : ""}
                            {item.parentWorkItemId
                              ? `↳${(state.workItems.find((parent) => parent.id === item.parentWorkItemId)?.title ?? "").slice(0, 12)} · `
                              : ""}
                            {item.title}
                          </p>
                        </button>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <OpcPriorityBadge priority={item.priority} />
                          {item.status !== "done" ? (
                            <OpcStatusBadge status={item.status} />
                          ) : null}
                          {!runnable &&
                          item.status !== "done" &&
                          item.status !== "cancelled" ? (
                            <span
                              className="inline-flex items-center rounded-md bg-surface-hover px-1.5 py-0.5 text-ui-xs text-foreground-faint"
                              title={unresolvedDeps
                                .map((dep) => dep.title)
                                .join("、")}
                            >
                              🔒{" "}
                              {intl.formatMessage(
                                { id: "opc.kanban.locked" },
                                { count: unresolvedDeps.length },
                              )}
                            </span>
                          ) : null}
                        </div>
                        {item.escalationNote ? (
                          <p className="mt-1 line-clamp-1 text-ui-xs text-amber-600 dark:text-amber-400">
                            {item.escalationNote}
                          </p>
                        ) : null}
                        <div className="mt-2 flex items-center justify-between">
                          <OpcEmployeeAvatar employee={assignee} />
                          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            {canDelegate ? (
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
                            {item.status === "review" ? (
                              <>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() =>
                                    onStatusChange(item.id, "done")
                                  }
                                  title={intl.formatMessage({
                                    id: "opc.kanban.approve",
                                  })}
                                >
                                  ✓
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => onRework(item)}
                                  title={intl.formatMessage({
                                    id: "opc.kanban.rework",
                                  })}
                                >
                                  ↩
                                </Button>
                              </>
                            ) : null}
                            {item.status === "done" && dependents.length > 0 ? (
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => onIntegrate(item)}
                                title={intl.formatMessage({
                                  id: "opc.kanban.integrate",
                                })}
                              >
                                {intl.formatMessage({
                                  id: "opc.kanban.integrate",
                                })}
                              </Button>
                            ) : null}
                            {item.escalatedAt ? (
                              <>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() =>
                                    onResolveEscalation(item.id, "takeover")
                                  }
                                  title={intl.formatMessage({
                                    id: "opc.kanban.takeover",
                                  })}
                                >
                                  {intl.formatMessage({
                                    id: "opc.kanban.takeover",
                                  })}
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() =>
                                    onResolveEscalation(item.id, "resume")
                                  }
                                  title={intl.formatMessage({
                                    id: "opc.kanban.resolveEscalation",
                                  })}
                                >
                                  ✕
                                </Button>
                              </>
                            ) : item.status !== "done" &&
                              item.status !== "cancelled" ? (
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => onEscalate(item)}
                                title={intl.formatMessage({
                                  id: "opc.kanban.escalate",
                                })}
                              >
                                ⬆
                              </Button>
                            ) : null}
                            {transitions
                              .filter(
                                (next) =>
                                  !(
                                    item.status === "review" &&
                                    next === "in_progress"
                                  ),
                              )
                              .map((next) => (
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
