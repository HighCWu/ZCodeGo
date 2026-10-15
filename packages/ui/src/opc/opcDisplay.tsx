/**
 * zcode-go OPC UI 公共小件：状态/优先级徽标、员工头像、数字概览芯片。
 * 文案统一走 zcode-go locale（opc.* 命名空间）。
 */
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpcEmployee,
  OpcWorkItemPriority,
  OpcWorkItemStatus,
} from "@zcode/shared";

export const OPC_WORK_ITEM_STATUSES: OpcWorkItemStatus[] = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
];

export function opcStatusMessageId(status: OpcWorkItemStatus): string {
  return `opc.status.${status}`;
}

export function opcPriorityMessageId(priority: OpcWorkItemPriority): string {
  return `opc.priority.${priority}`;
}

const STATUS_BADGE_CLASS: Record<OpcWorkItemStatus, string> = {
  backlog: "bg-surface-hover text-foreground-subtle",
  ready: "bg-primary/10 text-primary",
  in_progress: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  review: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  cancelled: "bg-surface-hover text-foreground-faint",
};

const PRIORITY_BADGE_TONE: Record<
  OpcWorkItemPriority,
  "default" | "secondary" | "destructive" | "outline"
> = {
  low: "outline",
  medium: "secondary",
  high: "default",
  urgent: "destructive",
};

export function OpcStatusBadge({ status }: { status: OpcWorkItemStatus }) {
  const { intl } = useZCodeIntl();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-ui-xs font-medium",
        STATUS_BADGE_CLASS[status],
      )}
    >
      {intl.formatMessage({ id: opcStatusMessageId(status) })}
    </span>
  );
}

export function OpcPriorityBadge({
  priority,
}: {
  priority: OpcWorkItemPriority;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Badge variant={PRIORITY_BADGE_TONE[priority]} className="text-ui-xs">
      {intl.formatMessage({ id: opcPriorityMessageId(priority) })}
    </Badge>
  );
}

export function OpcEmployeeAvatar({
  employee,
  className,
}: {
  employee: OpcEmployee | null;
  className?: string;
}) {
  if (!employee) {
    return (
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-card-border text-ui-xs text-foreground-faint",
          className,
        )}
      >
        —
      </span>
    );
  }
  return (
    <span
      title={employee.name}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-hover text-sm",
        employee.status !== "active" && "opacity-50",
        className,
      )}
    >
      {employee.emoji}
    </span>
  );
}

export function OpcStatChip({
  value,
  labelId,
}: {
  value: number | string;
  labelId: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex min-w-16 flex-col items-center rounded-lg border border-card-border bg-card px-3 py-2">
      <span className="text-ui-lg font-semibold tabular-nums text-foreground">
        {value}
      </span>
      <span className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: labelId })}
      </span>
    </div>
  );
}
