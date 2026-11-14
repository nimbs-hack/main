import type { ReactNode } from 'react'
import type { Selection } from '../state'

// One line of a list, drawn as a nav button. Opens its
// editor underneath when it is the selection; a check mark supplements the
// selected colour.
export function Row({
  index,
  name,
  meta,
  open,
  onToggle,
  children,
}: {
  index?: number
  name: string
  meta: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <li className={`item${open ? ' is-open' : ''}`}>
      <button type="button" className="nav-button" aria-pressed={open} aria-expanded={open} onClick={onToggle}>
        {index !== undefined && <span className="nav-button__meta">{String(index).padStart(2, '0')}</span>}
        <span className="nav-button__label">{name}</span>
        <span className="nav-button__meta">{meta}</span>
        <span className="nav-button__arrow" aria-hidden="true">
          {open ? '✓' : '→'}
        </span>
      </button>
      {open && <div className="item__body">{children}</div>}
    </li>
  )
}

export const isOpen = (selection: Selection, list: NonNullable<Selection>['list'], index: number) =>
  selection?.list === list && selection.index === index

export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}
