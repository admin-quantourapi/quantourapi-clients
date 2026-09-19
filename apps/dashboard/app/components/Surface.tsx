import type React from 'react'

export type SurfaceType = 'base' | 'elevated' | 'sink'

export interface SurfaceProps<T extends React.ElementType = 'div'> {
  as?: T
  surface: SurfaceType
  children?: React.ReactNode
  className?: string
}

export function Surface<T extends React.ElementType = 'div'>({
  as,
  surface,
  children,
  className = '',
  ...props
}: SurfaceProps<T> & Omit<React.ComponentPropsWithRef<T>, keyof SurfaceProps<T>>) {
  const Component = as || 'div'

  const surfaceClasses: Record<SurfaceType, string> = {
    base: 'surface-base bg-surface-base text-on-surface-base border-surface-base-border',
    elevated: 'surface-elevated bg-surface-elevated text-on-surface-elevated border-surface-elevated-border',
    sink: 'surface-sink bg-surface-sink text-on-surface-sink border-surface-sink-border',
  }

  const combinedClassName = `${surfaceClasses[surface] || ''} ${className}`.trim()

  return (
    <Component className={combinedClassName} {...props}>
      {children}
    </Component>
  )
}
