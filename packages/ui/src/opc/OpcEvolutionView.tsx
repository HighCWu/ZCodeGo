/**
 * zcode-go OPC 进化日志视图：事件流（招聘/工作项/复盘/晋升/技能升级）+ 经验清单。
 * 这是 RSI 闭环的可观测面：晋升历史一目了然。
 */
import { useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpcCompanyState } from "@zcode/shared";

const KIND_ICON: Record<string, string> = {
  "company-init": "🏛️",
  hire: "🧑‍💼",
  depart: "👋",
  workitem: "📋",
  retro: "🔁",
  promote: "⬆️",
  "skill-upgrade": "🧬",
  "skill-import": "📦",
  "template-import": "👥",
};

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function OpcEvolutionView({ state }: { state: OpcCompanyState }) {
  const { intl } = useZCodeIntl();
  const events = useMemo(
    () => [...state.evolution].sort((a, b) => b.at - a.at).slice(0, 200),
    [state.evolution],
  );
  const employeesById = useMemo(
    () => new Map(state.employees.map((employee) => [employee.id, employee])),
    [state.employees],
  );
  const lessons = useMemo(
    () =>
      [...state.lessons]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100),
    [state.lessons],
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-2">
      <div className="flex min-h-0 flex-col rounded-xl border border-card-border bg-surface">
        <p className="border-b border-card-border px-3 py-2 text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "opc.evolution.feed" })}
        </p>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1.5 p-3">
            {events.map((event) => (
              <div key={event.id} className="flex items-start gap-2 text-ui-sm">
                <span className="mt-0.5 shrink-0 text-sm">
                  {KIND_ICON[event.kind] ?? "·"}
                </span>
                <span className="min-w-0 flex-1 text-foreground-subtle">
                  {event.summary}
                </span>
                <span className="shrink-0 text-ui-xs tabular-nums text-foreground-faint">
                  {formatTime(event.at)}
                </span>
              </div>
            ))}
            {events.length === 0 ? (
              <p className="py-6 text-center text-ui-xs text-foreground-faint">
                —
              </p>
            ) : null}
          </div>
        </ScrollArea>
      </div>
      <div className="flex min-h-0 flex-col rounded-xl border border-card-border bg-surface">
        <p className="border-b border-card-border px-3 py-2 text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "opc.evolution.lessons" })}
        </p>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-3">
            {lessons.map((lesson) => {
              const employee = employeesById.get(lesson.employeeId);
              const promoted = state.skills.some(
                (skill) =>
                  skill.origin === "promoted" &&
                  employee?.skillRefs.includes(skill.id) &&
                  lesson.statement.slice(0, 20) ===
                    skill.name.replace(/^Playbook：/, "").slice(0, 20),
              );
              return (
                <div
                  key={lesson.id}
                  className="rounded-lg border border-card-border bg-card px-2.5 py-1.5"
                >
                  <p className="text-ui-sm text-foreground">
                    {promoted ? "⬆️ " : ""}
                    {lesson.statement}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-ui-xs text-foreground-faint">
                    <span>
                      {employee
                        ? `${employee.emoji} ${employee.name}`
                        : lesson.employeeId}
                    </span>
                    {lesson.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-surface-hover px-1 py-px"
                      >
                        {tag}
                      </span>
                    ))}
                    <span className="ml-auto tabular-nums">
                      {formatTime(lesson.createdAt)}
                    </span>
                  </p>
                </div>
              );
            })}
            {lessons.length === 0 ? (
              <p className="py-6 text-center text-ui-xs text-foreground-faint">
                —
              </p>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
