import { useState } from 'react'
import { withoutRepeats } from '../data/stops'
import type { Draft } from '../state'
import { Button, Select } from '../components/controls'
import { Row } from './parts'

// The plan: which sites the EVA visits, in what order. A stop is a site from
// the Sites tab. A site can come back later, as in A, B, A, C, A, but not
// twice in a row. The route on the map runs through the stops in this order.
export function PlanStep({
  draft,
  onAdd,
  onMove,
  onRemove,
}: {
  draft: Draft
  onAdd: (site: number) => void
  onMove: (index: number, to: number) => void
  onRemove: (index: number) => void
}) {
  const stops = draft.route ?? []
  const names = draft.sites.map((site) => site.name || 'Unnamed')
  const last = stops.at(-1)
  // The site the next stop will be. It starts on one that can follow the last.
  const [chosen, setChosen] = useState<number | null>(null)
  const pick = chosen !== null && chosen < names.length ? chosen : names.findIndex((_, i) => i !== last)
  const [open, setOpen] = useState(-1)
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)

  // True when moving a stop would not put a site right after itself.
  const canMove = (index: number, to: number) => {
    if (to < 0 || to >= stops.length) return false
    const moved = [...stops]
    moved.splice(to, 0, ...moved.splice(index, 1))
    return withoutRepeats(moved).length === moved.length
  }
  const role = (i: number) => (stops.length < 2 ? '' : i === 0 ? 'Start' : i === stops.length - 1 ? 'End' : `Stop ${i}`)
  const dragMark = (i: number) => {
    if (!drag) return ''
    if (drag.from === i) return 'is-dragged'
    if (drag.over !== i) return ''
    return drag.from < i ? 'is-drop-below' : 'is-drop-above'
  }

  if (draft.sites.length === 0) return <p className="note">No sites yet. Add them on the Sites tab, then plan the order here.</p>

  return (
    <>
      <div className="plan-add">
        <Select label="Next stop" value={names[pick] ?? ''} options={names} onChange={(name) => setChosen(names.indexOf(name))} />
        <Button disabled={pick < 0 || pick === last} title={pick === last ? 'The plan is at this site already' : undefined} onClick={() => onAdd(pick)}>
          Add stop
        </Button>
      </div>
      {stops.length === 0 && draft.sites.length > 1 && (
        <p className="note">No plan yet. Until there is one, the route visits the sites in their list order.</p>
      )}
      {stops.length === 1 && <p className="note">Add a second stop and the route runs to it.</p>}

      <ol className="items">
        {stops.map((site, i) => (
          <Row
            key={i}
            index={i + 1}
            name={names[site] ?? 'Unknown site'}
            meta={role(i)}
            open={open === i}
            onToggle={() => setOpen(open === i ? -1 : i)}
            drag={
              stops.length > 1
                ? {
                    mark: dragMark(i),
                    onStart: () => setDrag({ from: i, over: i }),
                    onEnd: () => setDrag(null),
                    onOver: () => drag && drag.over !== i && setDrag({ ...drag, over: i }),
                    onDrop: () => {
                      if (drag && canMove(drag.from, i)) onMove(drag.from, i)
                      setDrag(null)
                    },
                  }
                : undefined
            }
          >
            <div className="actions">
              <Button disabled={!canMove(i, i - 1)} onClick={() => onMove(i, i - 1)}>
                Earlier
              </Button>
              <Button disabled={!canMove(i, i + 1)} onClick={() => onMove(i, i + 1)}>
                Later
              </Button>
              <Button className="button--remove" onClick={() => onRemove(i)}>
                Remove stop
              </Button>
            </div>
          </Row>
        ))}
      </ol>
    </>
  )
}
