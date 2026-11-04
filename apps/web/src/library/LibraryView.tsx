import { useCan, useCapability, useCindlApi } from '@cindl/client-react'
import type { MemoryOverview, Skill } from '@cindl/contracts'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatRoute, type LibrarySection } from '../router.ts'
import { Badge, SectionTitle } from '../ui/primitives.tsx'
import { RequireCapability } from '../views/Capability.tsx'
import { DocumentEditor } from '../views/DocumentEditor.tsx'
import { SectionTabs } from '../views/SectionTabs.tsx'
import { MemoryEntries } from './MemoryEntries.tsx'
import { useResource } from '../views/useResource.ts'
import styles from '../views/views.module.css'

const sections: Array<{ id: LibrarySection; label: string }> = [
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'artifacts', label: 'Artifacts' },
]

function SkillDetail({ name }: { name: string }) {
  const api = useCindlApi()
  const canWrite = useCan('skills.write')
  const writeCapability = useCapability('skills.write')
  const skill = useResource(
    () => api.call('skills.read', { name }),
    `skill:${name}`,
    'This skill could not be read.',
  )
  return (
    <section className={styles.section} aria-labelledby="skill-title">
      <a
        className={styles.back}
        href={formatRoute({ view: 'library', section: 'skills' })}
      >
        <ChevronLeft size={16} aria-hidden="true" />
        All skills
      </a>
      <h2 id="skill-title" className={styles.pageTitle}>
        {name}
      </h2>
      {skill.error ? <p className={styles.error}>{skill.error}</p> : null}
      {skill.data ? (
        <DocumentEditor
          // One editor per skill: a save that finishes after the owner opened
          // another skill must not reset that skill's editor.
          key={name}
          document={skill.data}
          canWrite={canWrite}
          writeNote={writeCapability?.reason}
          onReload={skill.reload}
          onSave={async (content, expectedVersion) => {
            const saved = await api.call('skills.write', {
              name,
              content,
              expectedVersion,
              confirm: true,
            })
            skill.replace(saved)
            return saved
          }}
        />
      ) : null}
    </section>
  )
}

function Skills() {
  const api = useCindlApi()
  const list = useResource(
    () => api.call('skills.list', {}),
    'skills',
    'Skills could not be loaded.',
  )
  const skills: Skill[] | undefined = list.data
  const error = list.error
  if (error) return <p className={styles.error}>{error}</p>
  if (!skills) return <p className={styles.note}>Loading skills…</p>
  if (!skills.length)
    return <p className={styles.empty}>No skills are installed in this profile.</p>
  return (
    <ul className={styles.rows}>
      {skills.map((skill) => (
        <li key={skill.name}>
          <a
            className={`${styles.row} ${styles.rowLink}`}
            href={formatRoute({ view: 'library', section: 'skills', item: skill.name })}
          >
            <span className={styles.rowTitle}>{skill.name}</span>
            {skill.description ? (
              <span className={styles.rowDetail}>{skill.description}</span>
            ) : null}
            <span className={styles.rowAside}>
              {skill.category ? <span>{skill.category}</span> : null}
              {skill.enabled === false ? <Badge>Disabled</Badge> : null}
              <ChevronRight size={16} aria-hidden="true" className={styles.rowChevron} />
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}

function Memory() {
  const api = useCindlApi()
  const memory = useResource(
    () => api.call('memory.overview', {}),
    'memory',
    'Memory metadata could not be loaded.',
  )
  const overview: MemoryOverview | undefined = memory.data
  const error = memory.error
  return (
    <div className={styles.section}>
      {error ? <p className={styles.error}>{error}</p> : null}
      {overview ? (
        <>
          <dl className={styles.facts}>
            {overview.items.map((item) => (
              <div key={item.key} className={styles.factRow}>
                <dt>{item.label}</dt>
                <dd>{item.detail ?? '—'}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.note}>Source: {overview.source}.</p>
        </>
      ) : null}
      <RequireCapability id="memory.text" label="Memory entries">
        <MemoryEntries />
      </RequireCapability>
    </div>
  )
}

export function LibraryView({
  section,
  item,
}: {
  section: LibrarySection
  item?: string | undefined
}) {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Library</h1>
          <p className={styles.pageLead}>
            What Hermes knows how to do and what it keeps.
          </p>
        </header>
        <SectionTabs
          label="Library sections"
          items={sections}
          current={section}
          route={(id) => ({ view: 'library', section: id })}
        />
        {section === 'skills' ? (
          <RequireCapability id="skills.read" label="Skills">
            {item ? <SkillDetail name={item} /> : <Skills />}
          </RequireCapability>
        ) : null}
        {section === 'memory' ? (
          <section className={styles.section} aria-labelledby="memory-title">
            <SectionTitle id="memory-title">Memory</SectionTitle>
            <RequireCapability id="memory.overview" label="Memory overview">
              <Memory />
            </RequireCapability>
          </section>
        ) : null}
        {section === 'artifacts' ? (
          <section className={styles.section} aria-labelledby="artifacts-title">
            <SectionTitle id="artifacts-title">Artifacts</SectionTitle>
            <RequireCapability id="artifacts.list" label="Artifacts">
              <p className={styles.note}>Artifacts are available.</p>
            </RequireCapability>
          </section>
        ) : null}
      </div>
    </div>
  )
}
