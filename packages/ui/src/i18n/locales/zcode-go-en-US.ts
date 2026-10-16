/**
 * zcode-go 文案（en-US）——独立文件，locale 主文件的门控点仅 import + 一行 spread。
 */
export const zcodeGoMessagesEnUs: Record<string, string> = {
  "zcodeGoMobileBridge.signalingOrigin.title": "P2P signaling server",
  "zcodeGoMobileBridge.signalingOrigin.description":
    "Defaults to the official service; point to your own Worker for self-deployment.",
  "zcodeGoMobileBridge.signalingOrigin.apply": "Apply",
  "zcodeGoMobileBridge.signalingOrigin.applied": "Saved, QR refreshed",
  "zcodeGoMobileBridge.signalingOrigin.resetHint":
    "Clear and apply to restore the default service",
  "zcodeGoMobileBridge.signalingOrigin.saveFailed": "Save failed, please retry",
  "zcodeGoMobileBridge.signalingOrigin.invalidUrl":
    "Enter a valid https:// URL (http://localhost allowed for local testing)",
  "zcodeGoMobileBridge.signalingOrigin.envOverride":
    "Env ZCODE_GO_SIGNALING_ORIGIN is overriding — saved but not effective",
  "zcodeGoMobileBridge.section": "P2P direct",
  "zcodeGoMobileBridge.hint":
    "Scan the QR code or open the link on your phone to control this desktop. The connection is phone-to-desktop directly (WebRTC P2P).",
  "zcodeGoMobileBridge.copyLink.copied": "Copied",
  "zcodeGoMobileBridge.refresh": "Regenerate pairing code",
  "zcodeGo.fork.inProgress":
    "Forking {count} messages — the official fork copies full history and may take a while; the model context continues from the compaction summary. Switching automatically…",
  "taskList.openInNewWindow": "Open in new window",
  "taskList.openInNewWindowFailed":
    "Failed to open session in a new window: {error}",
  "settings.zcodeGo.title": "ZCode Go",
  "settings.zcodeGo.p2pBridge": "P2P direct remote bridge",
  "settings.zcodeGo.p2pBridgeDescription":
    "Enable the ZCode Go WebRTC direct channel in the remote dialog (zero relay when phone and desktop share a network; no third-party server). When off, the dialog keeps only the official relay entry.",
  "settings.zcodeGo.hoverForkDualSession": "Hover fork dual-session model",
  "settings.zcodeGo.hoverForkDualSessionDescription":
    "Manual fork produces a visible task row plus a lean active endpoint with hover redirect and background history backfill. When off, manual fork uses the compatible rotation model.",
  "settings.zcodeGo.mobileDrawer": "Mobile drawer viewport",
  "settings.zcodeGo.mobileDrawerDescription":
    "Render the sidebar as a slide-in drawer on mobile viewports. When off, mobile viewports render with the desktop layout.",
  "settings.zcodeGo.uiAutoRecovery": "UI crash auto-recovery",
  "settings.zcodeGo.uiAutoRecoveryDescription":
    "Automatically re-render or reload after a UI subtree crash (max 3 times per area within 5 minutes). When off, only manual recovery buttons are offered.",
  "settings.zcodeGo.takeoverCloseOfficial": "Close official ZCode on takeover",
  "settings.zcodeGo.takeoverCloseOfficialDescription":
    "When /zcode-go launches this app from the official ZCode conversation, quit the official processes automatically (exclusive takeover). When off, both apps keep running.",
  // zcode-go: OPC mode (AI-native company) messages
  "settings.interfaceMode.opc": "OPC Company Mode",
  "occupationOnboarding.opc": "OPC Company Mode",
  "occupationOnboarding.opcDescription":
    "Run AI as a company: hire role-based employees, delegate via kanban, and let experience self-upgrade into skills (self-evolving).",
  "opc.status.backlog": "Backlog",
  "opc.status.ready": "Ready",
  "opc.status.in_progress": "In Progress",
  "opc.status.review": "Review",
  "opc.status.done": "Done",
  "opc.status.cancelled": "Cancelled",
  "opc.priority.low": "Low",
  "opc.priority.medium": "Medium",
  "opc.priority.high": "High",
  "opc.priority.urgent": "Urgent",
  "opc.seniority.junior": "Junior",
  "opc.seniority.senior": "Senior",
  "opc.seniority.lead": "Lead",
  "opc.category.general": "General",
  "opc.category.engineering": "Engineering",
  "opc.category.design": "Design",
  "opc.category.product": "Product",
  "opc.category.research": "Research",
  "opc.category.finance": "Finance",
  "opc.category.sales": "Sales",
  "opc.category.marketing": "Marketing",
  "opc.category.media": "Media",
  "opc.category.operations": "Operations",
  "opc.category.education": "Education",
  "opc.category.executive": "Executive",
  "opc.panel.subtitle":
    "AI-native company console: delegate via kanban, hire from the talent market, and let repeated experience auto-promote into skills (self-evolving).",
  "opc.tab.kanban": "Kanban",
  "opc.tab.org": "Org",
  "opc.tab.market": "Talent Market",
  "opc.tab.skills": "Skills",
  "opc.tab.evolution": "Evolution",
  "opc.stat.employees": "Employees",
  "opc.stat.workItems": "Work Items",
  "opc.stat.active": "Active",
  "opc.stat.done": "Done",
  "opc.stat.skills": "Skills",
  "opc.stat.promoted": "Promoted",
  "opc.kanban.hint":
    "Work items advance along the state machine; delegating composes the role playbook and skills into a task prompt.",
  "opc.kanban.create": "New Work Item",
  "opc.kanban.delegate": "Delegate",
  "opc.org.hint":
    "Employees come from talent market templates or custom hiring; retrospectives distill experience into personal memory.",
  "opc.org.hire": "Custom Hire",
  "opc.org.roleSlots": "Roles:",
  "opc.org.newSlotPlaceholder": "New role title (e.g. Engineering Lead)",
  "opc.org.addSlot": "Add Role",
  "opc.org.founderTag": "Owner",
  "opc.org.stats":
    "Done {completed} · Retros {retrospectives} · Lessons {lessons}",
  "opc.org.pause": "Pause",
  "opc.org.resume": "Resume",
  "opc.org.depart": "Depart",
  "opc.org.retro": "Retrospective",
  "opc.market.hint":
    "24 built-in role templates (OpenOPC talent-format compatible); import more from a folder.",
  "opc.market.importPlaceholder":
    "Template folder path (OpenOPC talent .md files)",
  "opc.market.import": "Import Folder",
  "opc.market.hire": "Hire",
  "opc.skills.hint":
    "Skills live in the workspace .opc/skills/ and are injected when delegating; repeated lessons auto-promote into playbooks.",
  "opc.skills.importPlaceholder":
    "Skills folder path (recursive SKILL.md scan)",
  "opc.skills.import": "Import Folder",
  "opc.skills.upgrade": "Upgrade",
  "opc.skills.changelog": "Changelog",
  "opc.skills.attachTitle": "Attach to employees (injected when delegating)",
  "opc.skills.expand": "Details",
  "opc.skills.collapse": "Collapse",
  "opc.skills.attachedCount": "{count} employees attached",
  "opc.skills.originBuiltin": "Built-in",
  "opc.skills.originImported": "Imported",
  "opc.skills.originPromoted": "Promoted",
  "opc.evolution.feed": "Evolution events",
  "opc.evolution.lessons": "Lessons",
  "opc.workitem.createTitle": "New Work Item",
  "opc.workitem.editTitle": "Edit Work Item",
  "opc.workitem.title": "Title",
  "opc.workitem.detail": "Context & acceptance criteria",
  "opc.workitem.detailPlaceholder":
    "Describe the goal, boundaries and acceptance criteria (markdown)…",
  "opc.workitem.assignee": "Assignee",
  "opc.workitem.unassigned": "Unassigned",
  "opc.workitem.priority": "Priority",
  "opc.hire.title": "Hire",
  "opc.hire.name": "Employee name",
  "opc.hire.seniority": "Seniority",
  "opc.hire.roleSlot": "Role slot",
  "opc.hire.noSlot": "No role slot",
  "opc.hire.confirm": "Onboard",
  "opc.hire.customTitle": "Custom Hire",
  "opc.hire.category": "Category",
  "opc.hire.vibe": "One-line persona",
  "opc.hire.description": "Responsibilities",
  "opc.retro.title": "Retrospective",
  "opc.retro.description":
    "Distill session experience into structured lessons; the same lesson seen in two retros auto-promotes into a shared playbook skill.",
  "opc.retro.employee": "Employee",
  "opc.retro.workItem": "Related work item",
  "opc.retro.noWorkItem": "None",
  "opc.retro.outputLabel":
    "Retro output (paste agent output or write manually)",
  "opc.retro.outputPlaceholder":
    "Click 'Generate retro prompt' to ask the agent, then paste the opc-lessons block back here…",
  "opc.retro.generatePrompt": "Generate retro prompt",
  "opc.retro.parsedCount": "{count} lessons parsed",
  "opc.retro.submit": "Save lessons",
  "opc.upgrade.title": "Skill self-upgrade",
  "opc.upgrade.description":
    "Hand the current skill body to the agent for enhancement; saving bumps the version and records the change.",
  "opc.upgrade.goal": "Upgrade goal (optional)",
  "opc.upgrade.goalPlaceholder": "e.g. add mobile adaptation lessons",
  "opc.upgrade.generatePrompt": "Generate upgrade prompt",
  "opc.upgrade.newBody":
    "New body (paste the agent's opc-skill block or edit directly)",
  "opc.upgrade.newBodyPlaceholder":
    "Paste the four-backtick opc-skill block from the agent…",
  "opc.upgrade.submit": "Save new version",
  "opc.common.cancel": "Cancel",
  "opc.common.save": "Save",
  "opc.home.ipcUnavailable":
    "OPC company state channel unavailable (requires the desktop zcode-go runtime).",
  "opc.home.loading": "Opening company…",
  "opc.home.unavailable": "Company state is unavailable.",
  "opc.home.summary":
    "{employees} employees · {workItems} work items · {skills} skills",
  "opc.home.openPanel": "Open company panel",
  "opc.home.newWorkItem": "New work item",
  "opc.home.hire": "Hire employee",
  "opc.home.kanbanTitle": "Kanban overview",
  "opc.home.emptyCompany":
    "The company is brand new: hire a few employees from the talent market, or create your first work item.",
  // zcode-go: OPC Self-Run manager action messages
  "opc.kanban.locked": "{count} deps unresolved",
  "opc.kanban.escalate": "Escalate to owner",
  "opc.kanban.resolveEscalation": "Dismiss escalation",
  "opc.kanban.takeover": "Owner takes over",
  "opc.kanban.escalationFilter": "{count} escalations",
  "opc.kanban.approve": "Approve",
  "opc.kanban.rework": "Send back",
  "opc.kanban.integrate": "Integrate output",
  "opc.rework.title": "Send back for rework",
  "opc.rework.description":
    "The item returns to in progress; rework notes are injected into the next delegation and must be addressed.",
  "opc.rework.existing": "Existing rework notes",
  "opc.rework.notePlaceholder":
    "Why did acceptance fail and what should change…",
  "opc.rework.submit": "Send back",
  "opc.workitem.deps": "Dependencies",
  "opc.workitem.depsHint":
    "The item can enter execution/delegation only after all dependencies finish; it auto-moves from backlog to ready once they do.",
  // zcode-go: OPC org intelligence messages
  "opc.org.generate": "Generate from goal",
  "opc.org.presets": "Architecture presets",
  "opc.org.generateTitle": "Generate org from goal",
  "opc.org.generateDescription":
    "Let the agent design the org; paste its opc-org fenced block back to preview and apply in one click.",
  "opc.org.goalLabel": "Company goal",
  "opc.org.goalPlaceholder":
    "e.g. Build an automation tool for indie developers, commercialize in 3 months…",
  "opc.org.generatePrompt": "Generate org prompt",
  "opc.org.outputLabel": "Agent output (paste opc-org block)",
  "opc.org.outputPlaceholder": "Paste the agent's opc-org fenced JSON…",
  "opc.org.parseFailed":
    "Failed to parse the opc-org fenced block; check the output format",
  "opc.org.parsed":
    "Will create {slots} roles, hire {hires}, reuse {reused}, skip {skipped}",
  "opc.org.apply": "Apply org",
  "opc.org.presetTitle": "Architecture presets",
  "opc.org.presetDescription":
    "Apply a built-in org preset; existing roles and same-name active employees are deduplicated.",
  "opc.org.presetSummary":
    "Will create {slots} roles, hire {hires}, reuse {reused}, skip {skipped}",
  "opc.hire.reuseHint":
    'Found "{name}" ({status}) matching this template — reusing inherits their full experience profile and stats.',
  "opc.hire.reuse": 'Reactivate "{name}"',
  "opc.employee.statusPaused": "paused",
  "opc.employee.statusDeparted": "departed",
  // zcode-go: OPC company package messages
  "opc.org.exportCompany": "Export company",
  "opc.org.exportArchitecture": "Export org",
  "opc.org.importArchitecture": "Import org",
  "opc.org.importCompany": "Import company",
  "opc.skills.export": "Export",
  // zcode-go: OPC office map & permission messages
  "opc.tab.office": "Office",
  "opc.office.hint":
    "Office map: the ring reflects workload — working (blue) / review (amber) / escalated (red) / idle; click a desk for details.",
  "opc.office.idle": "Idle",
  "opc.office.working": "Working ×{count}",
  "opc.office.pendingReview": "Review ×{count}",
  "opc.office.escalated": "Escalated ×{count}",
  "opc.office.founderDesk": "Owner's office",
  "opc.office.noItems": "No active work items",
  "opc.permission.read-only": "Read-only",
  "opc.permission.workspace-write": "Workspace write",
  "opc.permission.full-access": "Full access",
  "opc.hire.permission": "Permission level",
  // zcode-go: OPC inbound queue messages
  "opc.kanban.inboxFilter": "{count} inbound",
  "opc.inbox.title": "Inbound queue",
  "opc.inbox.description":
    "Items dropped by external channels (.opc/inbox/); converting creates a work item through the normal path, dismissing removes the file. Default priority/assignee apply to this batch.",
  "opc.inbox.assignee": "Assignee",
  "opc.inbox.convert": "Convert",
  "opc.inbox.dismiss": "Dismiss",
  "opc.inbox.empty": "Inbound queue is empty (see the ingest contract in spec)",
  "opc.orchestrate.button": "🚀 Orchestrate",
  "opc.orchestrate.hint":
    "Ready & assigned work items: {count} (dispatched as headless sessions)",
  "opc.common.close": "Close",
  // zcode-go: OPC orchestrator messages
  "settings.zcodeGo.opcAutoOrchestrate": "OPC auto-orchestrate",
  "settings.zcodeGo.opcAutoOrchestrateDescription":
    'The kanban "orchestrate" button dispatches every ready & assigned work item as a background session (desktop-continuous, concurrency cap 3).',
  "opc.kanban.orchestrate": "Orchestrate {count}",
  "opc.kanban.orchestrateTitle":
    "Dispatch all ready & assigned items headlessly (background sessions; verify in the task list when done)",
  // zcode-go: OPC escalation routing & project retro messages (⑦ gap fix)
  "opc.escalate.title": "Escalation",
  "opc.escalate.description":
    "Route to the best-fit teammate first; escalate to the owner only if the team can't resolve it.",
  "opc.escalate.routeTitle": "Route to a team member",
  "opc.escalate.noCandidates":
    "No active teammates to route to — escalate to the owner directly.",
  "opc.escalate.peer": "same category · {completed} done",
  "opc.escalate.top": "{completed} done",
  "opc.escalate.transferNote": "escalation routing",
  "opc.escalate.ownerNote": "Escalate to owner (with note)",
  "opc.escalate.notePlaceholder":
    "Describe the blocker and the decision needed…",
  "opc.escalate.toOwner": "Escalate to owner",
  "opc.evolution.projectRetro": "Project retro",
  "opc.projectRetro.title": "Project retrospective",
  "opc.projectRetro.description":
    "Review recent work items and distill lessons per employee; unattributed lessons go to the founder.",
  "opc.projectRetro.goalLabel": "Retro focus (optional)",
  "opc.projectRetro.goalPlaceholder":
    "e.g. delivery cadence & quality review for this iteration…",
  "opc.projectRetro.generatePrompt": "Generate retro prompt",
  "opc.projectRetro.outputLabel": "Agent output (paste opc-lessons block)",
  "opc.projectRetro.outputPlaceholder":
    "Paste the agent's opc-lessons fenced JSON…",
  "opc.projectRetro.submit": "Record per employee",
};
