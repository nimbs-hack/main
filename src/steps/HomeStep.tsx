import { Button, ConfirmButton } from '../components/controls'
import { StageIcon } from '../components/icons'
import { words } from '../numbers'
import type { Draft, LibraryEntry } from '../state'

const count = (n: number, thing: string) => `${n} ${thing}${n === 1 ? '' : 's'}`

const contents = (mission: Draft): string =>
  [
    words(mission.type),
    `${mission.crew.length} crew`,
    count(mission.phases.length, 'phase'),
    count(mission.sites.length, 'site'),
  ].join(' · ')

// Local date and time, short: 14 Nov 2026, 19:42.
const when = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

// Where the app starts: the mission in progress, then every mission saved
// from here or received as a file, newest first. Files are opened here.
export function HomeStep({
  draft,
  library,
  onContinue,
  onOpen,
  onDelete,
  onOpenFile,
  onNew,
}: {
  draft: Draft
  library: LibraryEntry[]
  onContinue: () => void
  onOpen: (entry: LibraryEntry) => void
  onDelete: (entry: LibraryEntry) => void
  onOpenFile: () => void
  onNew: () => void
}) {
  return (
    <section className="card">
      <h2 className="card__title">
        <StageIcon id="home" />
        Missions
      </h2>
      <div className="actions">
        <Button onClick={onOpenFile} title="Ctrl+O">
          Open mission file
        </Button>
        <Button onClick={onNew}>New mission</Button>
      </div>

      <ul className="people">
        <li className="person is-selected">
          <div className="person__line">
            <span className="person__who">
              <span className="person__name">{draft.name || 'Unnamed'}</span>
              <span className="person__meta">In progress · {contents(draft)}</span>
            </span>
            <Button onClick={onContinue}>Continue</Button>
          </div>
        </li>
        {library.map((entry) => (
          <li key={entry.id} className="person">
            <div className="person__line">
              <span className="person__who">
                <span className="person__name">{entry.mission.name || 'Unnamed'}</span>
                <span className="person__meta">
                  {entry.source === 'saved' ? 'Saved' : `Received${entry.file ? ` as ${entry.file}` : ''}`}{' '}
                  {when(entry.at)} · {contents(entry.mission)}
                </span>
              </span>
              <ConfirmButton
                label="Delete"
                confirmLabel="Confirm"
                aria-label={`Delete ${entry.mission.name || 'unnamed mission'} from this list`}
                onConfirm={() => onDelete(entry)}
              />
              <Button onClick={() => onOpen(entry)}>Open</Button>
            </div>
          </li>
        ))}
      </ul>
      {library.length === 0 && (
        <p className="note">Nothing saved or received yet. Save a mission from Review, or open a mission file.</p>
      )}
    </section>
  )
}
