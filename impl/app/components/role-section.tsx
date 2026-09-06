"use client";

type RoleSectionProps = {
  title: string;
  actions: readonly string[];
  enabled: boolean;
};

export function RoleSection({ title, actions, enabled }: RoleSectionProps) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-medium tracking-tight text-muted">{title}</h2>
      <div className="flex gap-3">
        {actions.map((label) => (
          <button
            key={label}
            type="button"
            disabled={!enabled}
            className="rounded-lg border border-neutral-400 bg-card px-5 py-2.5 text-sm font-medium shadow-xs transition enabled:hover:border-neutral-600 enabled:hover:bg-cream disabled:pointer-events-none dark:border-neutral-600 dark:enabled:hover:border-neutral-500"
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
