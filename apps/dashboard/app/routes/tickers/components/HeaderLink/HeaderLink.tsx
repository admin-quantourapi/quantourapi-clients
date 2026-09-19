import {
  NavLink, useRouteLoaderData, 
} from 'react-router'

type LinkColor = 'primary' | 'secondary' | 'emerald' | 'amber' | 'rose' | 'indigo' | 'violet'

export function HeaderLink({
  to,
  color,
  children,
}: {
  to: string
  color: LinkColor
  children: React.ReactNode
}) {
  const baseMap: Record<LinkColor, { border: string; text: string; bgHover: string; textHover: string; bgActive: string; textActive: string; shadowActive: string }> = {
    primary: {
      border: 'border-primary/30 hover:border-primary/80',
      text: 'text-primary/80 hover:text-primary',
      bgHover: 'hover:bg-primary/10',
      textHover: 'hover:text-primary',
      bgActive: 'bg-primary text-on-primary font-black',
      textActive: 'text-on-primary',
      shadowActive: 'shadow-[0_0_12px_rgba(26,188,156,0.35)]',
    },
    secondary: {
      border: 'border-secondary/30 hover:border-secondary/80',
      text: 'text-secondary/80 hover:text-secondary',
      bgHover: 'hover:bg-secondary/10',
      textHover: 'hover:text-secondary',
      bgActive: 'bg-secondary text-on-secondary font-black',
      textActive: 'text-on-secondary',
      shadowActive: 'shadow-[0_0_12px_rgba(0,216,214,0.35)]',
    },
    emerald: {
      border: 'border-up/30 hover:border-up/80',
      text: 'text-up/80 hover:text-up',
      bgHover: 'hover:bg-up/10',
      textHover: 'hover:text-up',
      bgActive: 'bg-up text-foreground font-black',
      textActive: 'text-foreground',
      shadowActive: 'shadow-[0_0_12px_rgba(16,185,129,0.35)]',
    },
    amber: {
      border: 'border-warning/30 hover:border-warning/80',
      text: 'text-warning/80 hover:text-warning',
      bgHover: 'hover:bg-warning/10',
      textHover: 'hover:text-warning',
      bgActive: 'bg-warning text-foreground font-black',
      textActive: 'text-foreground',
      shadowActive: 'shadow-[0_0_12px_rgba(245,158,11,0.35)]',
    },
    rose: {
      border: 'border-danger/30 hover:border-danger/80',
      text: 'text-danger/80 hover:text-danger',
      bgHover: 'hover:bg-danger/10',
      textHover: 'hover:text-danger',
      bgActive: 'bg-danger text-on-surface-sink font-black',
      textActive: 'text-on-surface-sink',
      shadowActive: 'shadow-[0_0_12px_rgba(244,63,94,0.35)]',
    },
    indigo: {
      border: 'border-info/30 hover:border-info/80',
      text: 'text-info/80 hover:text-primary',
      bgHover: 'hover:bg-info/10',
      textHover: 'hover:text-primary',
      bgActive: 'bg-info text-on-surface-sink font-black',
      textActive: 'text-on-surface-sink',
      shadowActive: 'shadow-[0_0_12px_rgba(99,102,241,0.35)]',
    },
    violet: {
      border: 'border-special/30 hover:border-special/80',
      text: 'text-special/80 hover:text-special',
      bgHover: 'hover:bg-special/10',
      textHover: 'hover:text-special',
      bgActive: 'bg-special text-on-surface-sink font-black',
      textActive: 'text-on-surface-sink',
      shadowActive: 'shadow-[0_0_12px_rgba(139,92,246,0.35)]',
    },
  }

  const styles = baseMap[color]
 
  let hasPending = false
  try {
    const rootData = useRouteLoaderData('root') as { hasPending?: boolean } | undefined
    hasPending = rootData?.hasPending ?? false
  } catch {
    // Ignore context errors
  }

  const showPendingDot = to === '/macro-narratives' && hasPending

  return (
    <NavLink
      to={to}
      className={({ isActive }) => {
        return `text-micro md:text-micro font-bold px-3 py-1.5 border rounded-xl transition-all duration-200 uppercase tracking-wider backdrop-blur-sm transform hover:scale-[1.03] active:scale-[0.97] flex items-center gap-1.5 ${
          isActive
            ? `${styles.bgActive} ${styles.shadowActive} border-transparent`
            : `bg-surface-sink/40 ${styles.border} ${styles.text} ${styles.bgHover} ${styles.textHover}`
        }`
      }}
    >
      {children}
      {showPendingDot && (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-info opacity-75"></span>
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-info"></span>
        </span>
      )}
    </NavLink>
  )
}
