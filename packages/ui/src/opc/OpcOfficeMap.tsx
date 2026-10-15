/**
 * zcode-go OPC Office 办公室地图（OpenOPC 招牌可视化的轻量形态）。
 * 在职员工以桌位卡呈现在办公室平面上（创始人独立办公桌），状态环实时反映
 * 工作负载：执行中（蓝）/ 待验收（琥珀）/ 升级中（红）/ 空闲；点选员工展开
 * 详情（当前工作项 + 复盘入口）。桌位按入职顺序确定性排布，不持久化。
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpcCompanyState, OpcEmployee, OpcWorkItem } from "@zcode/shared";

type Workload = "idle" | "working" | "review" | "escalated";

interface Desk {
  employee: OpcEmployee;
  workload: Workload;
  currentItems: OpcWorkItem[];
}

const WORKLOAD_RING: Record<Workload, string> = {
  idle: "border-card-border",
  working: "border-blue-500/70",
  review: "border-amber-500/80",
  escalated: "border-destructive",
};

const WORKLOAD_LABEL_ID: Record<Workload, string> = {
  idle: "opc.office.idle",
  working: "opc.office.working",
  review: "opc.office.pendingReview",
  escalated: "opc.office.escalated",
};

function resolveWorkload(items: OpcWorkItem[]): Workload {
  if (items.some((item) => item.escalatedAt)) return "escalated";
  if (items.some((item) => item.status === "review")) return "review";
  if (items.some((item) => item.status === "in_progress")) return "working";
  return "idle";
}

export function OpcOfficeMap({
  state,
  onRetrospective,
}: {
  state: OpcCompanyState;
  onRetrospective: (employee: OpcEmployee) => void;
}) {
  const { intl } = useZCodeIntl();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const desks = useMemo<Desk[]>(() => {
    const itemsByAssignee = new Map<string, OpcWorkItem[]>();
    for (const item of state.workItems) {
      if (!item.assigneeId) continue;
      if (item.status === "done" || item.status === "cancelled") continue;
      const list = itemsByAssignee.get(item.assigneeId) ?? [];
      list.push(item);
      itemsByAssignee.set(item.assigneeId, list);
    }
    // 创始人固定第一张桌（所有者办公室），其余按入职顺序
    const active = [...state.employees]
      .filter((employee) => employee.status === "active")
      .sort(
        (a, b) =>
          Number(b.isFallback ?? false) - Number(a.isFallback ?? false) ||
          a.createdAt - b.createdAt,
      );
    return active.map((employee) => {
      const items = itemsByAssignee.get(employee.id) ?? [];
      return {
        employee,
        workload: resolveWorkload(items),
        currentItems: items,
      };
    });
  }, [state]);

  const selected =
    desks.find((desk) => desk.employee.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "opc.office.hint" })}
      </p>
      <div className="flex min-h-0 flex-1 gap-3">
        <ScrollArea className="min-h-0 flex-1">
          <div
            className="grid grid-cols-2 gap-3 rounded-xl border border-card-border bg-surface p-4 sm:grid-cols-3 xl:grid-cols-4"
            style={{
              backgroundImage:
                "linear-gradient(color-mix(in srgb, var(--border) 40%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--border) 40%, transparent) 1px, transparent 1px)",
              backgroundSize: "28px 28px",
            }}
          >
            {desks.map((desk) => (
              <button
                key={desk.employee.id}
                type="button"
                onClick={() => setSelectedId(desk.employee.id)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-xl border-2 bg-card p-3 text-center transition-shadow hover:shadow-md",
                  WORKLOAD_RING[desk.workload],
                  desk.workload === "working" && "zcode-go-opc-desk-working",
                  selectedId === desk.employee.id && "ring-2 ring-primary/60",
                )}
              >
                <span className="text-2xl leading-none">
                  {desk.employee.emoji}
                </span>
                <span className="max-w-full truncate text-ui-sm font-medium text-foreground">
                  {desk.employee.name}
                </span>
                <span className="text-ui-xs text-foreground-faint">
                  {intl.formatMessage(
                    { id: WORKLOAD_LABEL_ID[desk.workload] },
                    { count: desk.currentItems.length },
                  )}
                </span>
                {desk.currentItems[0] ? (
                  <span className="line-clamp-1 max-w-full text-ui-xs text-foreground-subtle">
                    {desk.currentItems[0].title}
                  </span>
                ) : null}
                {desk.employee.isFallback ? (
                  <span className="text-ui-xs text-foreground-faint">
                    {intl.formatMessage({ id: "opc.office.founderDesk" })}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </ScrollArea>
        {selected ? (
          <div className="hidden w-64 shrink-0 flex-col gap-2 rounded-xl border border-card-border bg-surface p-3 lg:flex">
            <div className="flex items-center gap-2">
              <span className="text-xl">{selected.employee.emoji}</span>
              <div className="min-w-0">
                <p className="truncate text-ui-sm font-medium text-foreground">
                  {selected.employee.name}
                </p>
                <p className="text-ui-xs text-foreground-faint">
                  {selected.employee.category} · {selected.employee.seniority}
                  {selected.employee.permissionLevel
                    ? ` · ${selected.employee.permissionLevel}`
                    : ""}
                </p>
              </div>
            </div>
            {selected.employee.vibe ? (
              <p className="text-ui-xs text-foreground-subtle">
                「{selected.employee.vibe}」
              </p>
            ) : null}
            <div className="flex flex-col gap-1">
              {selected.currentItems.length === 0 ? (
                <p className="text-ui-xs text-foreground-faint">
                  {intl.formatMessage({ id: "opc.office.noItems" })}
                </p>
              ) : (
                selected.currentItems.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-md border border-card-border bg-card px-2 py-1 text-ui-xs"
                  >
                    <p className="line-clamp-1 text-foreground">{item.title}</p>
                    <p className="text-foreground-faint">
                      {intl.formatMessage({ id: `opc.status.${item.status}` })}
                    </p>
                  </div>
                ))
              )}
            </div>
            <Button
              size="xs"
              variant="secondary"
              className="mt-auto"
              onClick={() => onRetrospective(selected.employee)}
            >
              {intl.formatMessage({ id: "opc.org.retro" })}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
