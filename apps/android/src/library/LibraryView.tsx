import { useCan, useCapability, useCindlApi } from '@cindl/client-react'
import { ScrollView, Text, View } from 'react-native'
import { librarySections, type LibrarySection } from '../nav/navigation.ts'
import { useNav, useNavigate } from '../nav/NavProvider.tsx'
import { useTheme } from '../theme/theme.tsx'
import { ChevronLeft } from '../ui/icons.ts'
import {
  Badge,
  Button,
  Empty,
  ErrorText,
  Facts,
  Note,
  Row,
  Rows,
} from '../ui/primitives.tsx'
import { DocumentEditor } from '../views/DocumentEditor.tsx'
import { Layer } from '../views/Layer.tsx'
import { Page, Section, Tabs } from '../views/Page.tsx'
import { RequireCapability } from '../views/RequireCapability.tsx'
import { useResource } from '../views/useResource.ts'
import { MemoryEntries } from './MemoryEntries.tsx'

const sectionLabels: Record<LibrarySection, string> = {
  skills: 'Skills',
  memory: 'Memory',
  artifacts: 'Artifacts',
}

function Skills() {
  const api = useCindlApi()
  const navigate = useNavigate()
  const list = useResource(
    () => api.call('skills.list', {}),
    'skills',
    'Skills could not be loaded.',
  )
  if (list.error) return <ErrorText>{list.error}</ErrorText>
  if (!list.data) return <Note>Loading skills…</Note>
  if (!list.data.length) return <Empty>No skills are installed in this profile.</Empty>
  return (
    <Rows>
      {list.data.map((skill) => (
        <Row
          key={skill.name}
          title={skill.name}
          detail={skill.description}
          aside={
            <>
              {skill.category ? <Badge>{skill.category}</Badge> : null}
              {skill.enabled === false ? <Badge>Disabled</Badge> : null}
            </>
          }
          accessibilityLabel={`${skill.name}${skill.description ? `, ${skill.description}` : ''}${
            skill.enabled === false ? ', disabled' : ''
          }. Open skill`}
          onPress={() => navigate({ type: 'skill', name: skill.name })}
        />
      ))}
    </Rows>
  )
}

function SkillDetail({ name }: { name: string }) {
  const api = useCindlApi()
  const theme = useTheme()
  const navigate = useNavigate()
  const canWrite = useCan('skills.write')
  const write = useCapability('skills.write')
  const skill = useResource(
    () => api.call('skills.read', { name }),
    `skill:${name}`,
    'This skill could not be read.',
  )
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        gap: theme.space[4],
        paddingHorizontal: theme.space[4],
        paddingTop: theme.space[3],
        paddingBottom: theme.space[10],
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Button
        label="All skills"
        icon={ChevronLeft}
        variant="quiet"
        style={{ alignSelf: 'flex-start', marginLeft: -theme.space[2] }}
        onPress={() => navigate({ type: 'skill', name: undefined })}
      />
      <Text
        accessibilityRole="header"
        style={[theme.text.heading, { color: theme.colors.text }]}
      >
        {name}
      </Text>
      {skill.error ? <ErrorText>{skill.error}</ErrorText> : null}
      {!skill.data && !skill.error ? <Note>Loading skill…</Note> : null}
      {skill.data ? (
        <DocumentEditor
          document={skill.data}
          label={name}
          canWrite={canWrite}
          writeNote={write?.reason}
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
    </ScrollView>
  )
}

function Memory() {
  const api = useCindlApi()
  const theme = useTheme()
  const memory = useResource(
    () => api.call('memory.overview', {}),
    'memory',
    'Memory metadata could not be loaded.',
  )
  return (
    <View style={{ gap: theme.space[3] }}>
      {memory.error ? <ErrorText>{memory.error}</ErrorText> : null}
      {memory.data ? (
        <>
          <Facts
            items={memory.data.items.map((item) => ({
              label: item.label,
              value: item.detail ?? 'Not reported',
            }))}
          />
          <Note>{`Source: ${memory.data.source}.`}</Note>
        </>
      ) : !memory.error ? (
        <Note>Loading memory metadata…</Note>
      ) : null}
    </View>
  )
}

export function LibraryView() {
  const nav = useNav()
  const navigate = useNavigate()
  const section = nav.librarySection
  const skillOpen = section === 'skills' && nav.skill !== undefined
  return (
    <View style={{ flex: 1 }}>
      <Layer visible={!skillOpen}>
        <Page
          title="Library"
          lead="What Hermes knows how to do and what it keeps."
          tabs={
            <Tabs
              label="Library sections"
              items={librarySections.map((id) => ({ id, label: sectionLabels[id] }))}
              current={section}
              onSelect={(id) => navigate({ type: 'library-section', section: id })}
            />
          }
        >
          {section === 'skills' ? (
            <RequireCapability id="skills.read" label="Skills">
              <Skills />
            </RequireCapability>
          ) : null}
          {section === 'memory' ? (
            <>
              <Section title="Memory">
                <RequireCapability id="memory.overview" label="Memory overview">
                  <Memory />
                </RequireCapability>
              </Section>
              <Section title="Entries">
                <RequireCapability id="memory.text" label="Memory entries">
                  <MemoryEntries />
                </RequireCapability>
              </Section>
            </>
          ) : null}
          {section === 'artifacts' ? (
            <Section title="Artifacts">
              <RequireCapability id="artifacts.list" label="Artifacts">
                <Note>Artifacts are available.</Note>
              </RequireCapability>
            </Section>
          ) : null}
        </Page>
      </Layer>
      {skillOpen && nav.skill ? (
        <Layer visible>
          <RequireCapability id="skills.read" label="Skills">
            <SkillDetail key={nav.skill} name={nav.skill} />
          </RequireCapability>
        </Layer>
      ) : null}
    </View>
  )
}
