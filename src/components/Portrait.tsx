// Portraits are image files in src/assets/crew, named after the call sign in
// lower case: vega.jpg for VEGA. Vite lists the folder at build time, so a
// crew member without a file costs no request.
const FILES = import.meta.glob<string>('../assets/crew/*.{jpg,jpeg,png,webp,avif}', {
  eager: true,
  query: '?url',
  import: 'default',
})

const BY_NAME = new Map(
  Object.entries(FILES).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.')).toLowerCase(), url]),
)

// The photo of a crew member, or their first two letters when there is none.
export function Portrait({ name, size = 'small' }: { name: string; size?: 'small' | 'large' }) {
  const url = BY_NAME.get(name.trim().toLowerCase())
  return url ? (
    <img className={`portrait portrait--${size}`} src={url} alt={`Portrait of ${name}`} />
  ) : (
    <span className={`portrait portrait--${size} portrait--none`} title="No portrait on file" aria-hidden="true">
      {name.trim().slice(0, 2) || '?'}
    </span>
  )
}
