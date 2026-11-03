import { diffLines, sha256Hex } from '@cindl/client-core'
import {
  CindlError,
  isCindlError,
  type CindlClientApi,
  type MemoryEntry,
  type MemoryEntrySummary,
  type MemoryStore,
  type VersionedDocument,
} from '@cindl/contracts'
import {
  bindingAfterSave,
  CLOSE_NO_LONGER_HERE,
  DELETE_REFUSED,
  DELETE_UNCERTAIN,
  deleteWarning,
  discardDraftLabel,
  entryAt,
  entryEditorView,
  followList,
  guardMemorySave,
  identityOf,
  keepsVanishedRow,
  MEMORY_DRAFT_PREFIX,
  memoryDelete,
  memoryDocument,
  memoryEntryName,
  memoryStores,
  memoryWrite,
  NO_LONGER_HERE,
  orphanDrafts,
  placeNow,
  placeOf,
  readForAdoption,
  readRequest,
  rowIsEntry,
  type EditorBinding,
  type MemoryPlace,
} from '../src/library/memory.ts'
import { describeFailure, NOT_APPLIED, SAVE_UNCERTAIN } from '../src/talk/failures.ts'
import {
  forgetDocumentDraft,
  keptDocumentDrafts,
  keptDrafts,
} from '../src/views/drafts.ts'
import {
  draftNotice,
  initialStage,
  keptDraft,
  lockPanel,
  previousTextOffer,
  reviewMoved,
  reviewStage,
  type Stage,
} from '../src/views/editorModel.ts'
import {
  failedRead,
  replaceForKey,
  type ResourceState,
} from '../src/views/useResource.ts'

/*
 * The Library's Memory screen without React Native, for Node tests. React
 * Native components are not rendered here (they run on the emulator in CI),
 * so this keeps the state and the wiring of MemoryEntries, EntryEditor and
 * DeleteEntry (src/library/MemoryEntries.tsx), DocumentEditor
 * (src/views/DocumentEditor.tsx) and useResource (src/views/useResource.ts),
 * and calls the same functions they call, in the same order:
 *
 * - every decision comes from the shared functions (`entryEditorView`,
 *   `followList`, `readRequest`, `readForAdoption`, `lockPanel`, `keptDraft`…),
 *   so a change to one of them changes what these tests see;
 * - state changes from a press or a change render at once (as an event does);
 *   state changes in async callbacks render when the test settles, batched;
 * - a render-time adjustment re-runs only its component's render, as React
 *   does; effects run after the render that changed their dependencies,
 *   children first; layout effects before them;
 * - a press or a change acts through the handler of the render on screen;
 *   while a dialog is open, only its buttons can be pressed (its scrim covers
 *   the rest);
 * - an unmounted component's state updates are dropped.
 *
 * What it shows is a list of nodes in screen order, queried like the web
 * tests query the DOM (role, accessible name, text). SYNTHETIC data only.
 */

export type ScreenNode =
  | {
      kind: 'text'
      text: string
      role?: 'alert' | 'header'
      live?: 'polite' | 'assertive'
      /** The document text in the editor's view stage, or the review's diff. */
      tag?: 'shown' | 'changes'
      dialog?: string
    }
  | {
      kind: 'button'
      label: string
      /** The accessible name: accessibilityLabel, else the label. */
      name: string
      disabled: boolean
      press: () => void
      dialog?: string
    }
  | {
      kind: 'field'
      label: string
      value: string
      readOnly: boolean
      change: (text: string) => void
    }

type Call = CindlClientApi['call']

interface Resource<T> {
  key: string
  token: number
  state: ResourceState<T> | undefined
  load: () => Promise<T>
  fallback: string
  ran: { key: string; token: number; alive: { value: boolean } } | undefined
  mounted: boolean
}

interface DocumentEditorState {
  alive: boolean
  stage: Stage
  failure: { message: string; conflict: boolean } | undefined
  saving: boolean
  backup: { content: string; version: string } | undefined
  keepDeps: [string, string | undefined] | undefined
}

interface DeleteEntryState {
  key: string
  alive: boolean
  confirming: boolean
  busy: boolean
  error: string | undefined
}

interface EntryEditorState {
  key: string
  alive: boolean
  binding: EditorBinding
  adoptedFrom: string | undefined
  adoption: { busy: boolean; error?: string | undefined } | undefined
  followed: [string | undefined, string | undefined]
  row: { current: MemoryEntrySummary | undefined }
  mounted: { current: boolean }
  entry: Resource<MemoryEntry>
  doc: DocumentEditorState | undefined
  del: DeleteEntryState | undefined
}

interface RootState {
  alive: boolean
  list: Resource<MemoryEntrySummary[]>
  open: MemoryPlace | undefined
  editor: EntryEditorState | undefined
}

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
const matches = (value: string, match: string | RegExp) =>
  typeof match === 'string' ? value === match : match.test(value)

export function memoryScreen(api: { call: Call }, options: { canWrite?: boolean } = {}) {
  const canWrite = options.canWrite ?? true
  let rendering = false
  let dirty = false
  let activity = 0
  let nodes: ScreenNode[] = []
  let root: RootState | undefined

  /** A state update outside rendering: rendered by the next flush. */
  const changed = () => {
    activity += 1
    if (!rendering) dirty = true
  }
  /** setState on a component: dropped once it unmounted. */
  const set = (instance: { alive: boolean }, update: () => void) => {
    if (!instance.alive) return
    update()
    changed()
  }

  function resource<T>(fallback: string): Resource<T> {
    return {
      key: '',
      token: 0,
      state: undefined,
      load: () => Promise.reject(new Error('not rendered')),
      fallback,
      ran: undefined,
      mounted: true,
    }
  }

  /** useResource during a render: the latest load, data for this key only. */
  function useResource<T>(r: Resource<T>, load: () => Promise<T>, key: string) {
    r.load = load
    r.key = key
    const current = r.state?.key === key ? r.state : undefined
    const token = r.token
    return {
      data: current?.data,
      error: current?.error,
      reload: () => {
        if (!r.mounted) return
        r.token += 1
        changed()
      },
      replace: (data: T) => {
        if (!r.mounted) return
        r.state = replaceForKey(r.state, { key, token, data })
        changed()
      },
    }
  }

  /** useResource's effect: runs when [key, token] changed; a stale answer is dropped. */
  function resourceEffect<T>(r: Resource<T>) {
    if (r.ran && r.ran.key === r.key && r.ran.token === r.token) return
    if (r.ran) r.ran.alive.value = false
    const alive = { value: true }
    const { key, token } = r
    r.ran = { key, token, alive }
    r.load().then(
      (data) => {
        activity += 1
        if (!alive.value) return
        r.state = { key, token, data }
        changed()
      },
      (error: unknown) => {
        activity += 1
        if (!alive.value) return
        const message = isCindlError(error) ? error.message : r.fallback
        r.state = failedRead(r.state, { key, token, error: message })
        changed()
      },
    )
  }

  function unmountResource<T>(r: Resource<T>) {
    r.mounted = false
    if (r.ran) r.ran.alive.value = false
  }

  function unmountEditor(editor: EntryEditorState) {
    editor.alive = false
    editor.mounted.current = false
    unmountResource(editor.entry)
    if (editor.doc) editor.doc.alive = false
    if (editor.del) editor.del.alive = false
  }

  interface Commit {
    layout: Array<() => void>
    passive: Array<() => void>
  }

  function renderRoot(): { nodes: ScreenNode[]; dialogs: ScreenNode[]; commit: Commit } {
    const out: ScreenNode[] = []
    const dialogs: ScreenNode[] = []
    const commit: Commit = { layout: [], passive: [] }
    const state = root
    if (!state) return { nodes: out, dialogs, commit }
    const list = useResource(
      state.list,
      () => api.call('memory.entries', {}),
      'memory-entries',
    )
    const listData = list.data
    const entries = listData ?? []
    const open = state.open
    const selected = open ? entryAt(entries, open) : undefined
    const setOpen = (place: MemoryPlace | undefined) =>
      set(state, () => (state.open = place))
    const orphans =
      open || !listData
        ? []
        : orphanDrafts(entries, keptDocumentDrafts(MEMORY_DRAFT_PREFIX))
    if (list.error) out.push({ kind: 'text', text: list.error, role: 'alert' })
    if (!listData && !list.error)
      out.push({ kind: 'text', text: 'Loading memory entries…' })
    if (listData && !entries.length && !open)
      out.push({ kind: 'text', text: 'Hermes has no memory entries yet.' })
    if (orphans.length) {
      out.push({ kind: 'text', text: 'Unsaved drafts', role: 'header' })
      out.push({
        kind: 'text',
        text: 'Text you wrote for entries Hermes no longer lists (removed, or changed elsewhere). Copy what you need; nothing here is saved.',
      })
      for (const { key, draft } of orphans) {
        out.push({ kind: 'text', text: draft })
        out.push({
          kind: 'button',
          label: 'Discard draft',
          name: discardDraftLabel(draft),
          disabled: false,
          press: () => set(state, () => forgetDocumentDraft(key)),
        })
      }
    }
    let rendered: string | undefined
    const editor = (
      store: MemoryStore,
      summary: MemoryEntrySummary | undefined,
      place: number,
      key: string,
    ) => {
      if (state.editor && state.editor.key !== key) {
        unmountEditor(state.editor)
        state.editor = undefined
      }
      rendered = key
      renderEntryEditor(out, dialogs, commit, {
        store,
        summary,
        place,
        key,
        state,
        placeNow: (identity) => placeNow(entries, identity),
        onChanged: list.reload,
        onDeleted: () => {
          setOpen(undefined)
          list.reload()
        },
      })
    }
    for (const { store, title, hint } of memoryStores) {
      const inStore = entries.filter((entry) => entry.store === store)
      const vanished =
        open?.store === store && keepsVanishedRow(open, selected, Boolean(listData))
      if (!inStore.length && !vanished) continue
      out.push({ kind: 'text', text: title, role: 'header' })
      out.push({ kind: 'text', text: hint })
      inStore.forEach((entry, index) => {
        const isOpen = selected?.id === entry.id
        out.push({
          kind: 'text',
          text: isOpen
            ? capitalized(memoryEntryName(store, index + 1))
            : `${entry.preview}${entry.truncated ? '…' : ''}`,
        })
        out.push({
          kind: 'button',
          label: isOpen ? 'Close' : 'Open',
          name: `${isOpen ? 'Close' : 'Open'} memory entry: ${entry.title}`,
          disabled: false,
          press: () => setOpen(isOpen ? undefined : placeOf(entries, entry.id)),
        })
        if (isOpen) editor(store, entry, index + 1, `${store}:${index}`)
      })
      if (vanished && open) {
        out.push({ kind: 'text', text: NO_LONGER_HERE })
        out.push({
          kind: 'button',
          label: 'Close',
          name: CLOSE_NO_LONGER_HERE,
          disabled: false,
          press: () => setOpen(undefined),
        })
        editor(store, undefined, open.index + 1, `${store}:${open.index}`)
      }
    }
    if (state.editor && rendered !== state.editor.key) {
      const gone = state.editor
      state.editor = undefined
      unmountEditor(gone)
    }
    commit.passive.push(() => resourceEffect(state.list))
    return { nodes: out, dialogs, commit }
  }

  function renderEntryEditor(
    out: ScreenNode[],
    dialogs: ScreenNode[],
    commit: Commit,
    props: {
      store: MemoryStore
      summary: MemoryEntrySummary | undefined
      place: number
      key: string
      state: RootState
      placeNow: (identity: string | undefined) => number | undefined
      onChanged: () => void
      onDeleted: () => void
    },
  ) {
    const { store, summary, place, onChanged, onDeleted } = props
    let mounting = false
    if (!props.state.editor) {
      mounting = true
      props.state.editor = {
        key: props.key,
        alive: true,
        binding: { identity: summary && identityOf(summary.id), savedFrom: undefined },
        adoptedFrom: undefined,
        adoption: undefined,
        followed: [summary?.id, undefined],
        row: { current: summary },
        mounted: { current: true },
        entry: resource<MemoryEntry>(
          'This entry could not be loaded. It may have changed; reload the list.',
        ),
        doc: undefined,
        del: undefined,
      }
    }
    const self = props.state.editor
    // EntryEditor's render, re-run after a render-time adjustment.
    let entry: ReturnType<typeof useResource<MemoryEntry>>
    let view: ReturnType<typeof entryEditorView>
    for (let pass = 0; ; pass++) {
      if (pass > 10) throw new Error('EntryEditor keeps adjusting while rendering')
      const binding = self.binding
      entry = useResource(
        self.entry,
        () => {
          const request = readRequest(summary?.id, rowIsEntry(summary?.id, binding))
          return request instanceof CindlError
            ? Promise.reject(request)
            : api.call('memory.read', request)
        },
        `memory:${store}:${place}`,
      )
      view = entryEditorView({
        binding,
        adoptedFrom: self.adoptedFrom,
        row: summary,
        read: entry.data,
        store,
        place,
        placeNow: props.placeNow,
        kept: (key) => keptDrafts.has(key),
      })
      if (self.followed[0] !== summary?.id || self.followed[1] !== entry.data?.id) {
        self.followed = [summary?.id, entry.data?.id]
        const next = followList({
          rowId: summary?.id,
          savedFrom: binding.savedFrom,
          rowIsIt: view.rowIsIt,
          readId: entry.data?.id,
          readFailed: entry.error !== undefined,
        })
        if (next.clearSavedFrom) self.binding = { ...binding, savedFrom: undefined }
        if (next.reread) entry.reload()
        continue
      }
      break
    }
    const data = entry.data
    const { locked, draftKey } = view
    const adopt = (target: MemoryEntrySummary, from: string) => {
      set(self, () => (self.adoption = { busy: true }))
      void readForAdoption({
        read: (args) => api.call('memory.read', args),
        target,
        from,
        rowNow: () => self.row.current,
      }).then((outcome) => {
        activity += 1
        if (!self.mounted.current) return
        if (!outcome.ok) {
          set(self, () => (self.adoption = { busy: false, error: outcome.error }))
          return
        }
        entry.replace(outcome.read)
        set(self, () => {
          self.adoptedFrom = outcome.adoptedFrom
          self.binding = { identity: outcome.identity, savedFrom: undefined }
          self.adoption = undefined
        })
      })
    }
    const target = view.adoptTarget
    if (entry.error && (!data || !locked)) {
      out.push({ kind: 'text', text: entry.error, role: 'alert', live: 'assertive' })
      out.push({
        kind: 'button',
        label: 'Reload',
        name: 'Reload',
        disabled: false,
        press: () => {
          entry.reload()
          onChanged()
        },
      })
    }
    if (!data && !entry.error) out.push({ kind: 'text', text: 'Loading entry…' })
    if (data && draftKey) {
      if (!self.doc)
        self.doc = {
          alive: true,
          stage: initialStage(keptDrafts.get(draftKey)),
          failure: undefined,
          saving: false,
          backup: undefined,
          keepDeps: undefined,
        }
      renderDocumentEditor(out, commit, self.doc, {
        document: memoryDocument(data, place),
        draftKey,
        locked: view.lockNotice,
        onAdopt: target ? () => adopt(target, draftKey) : undefined,
        adoption: self.adoption,
        draftNote: view.draftNote,
        keepDraft: view.keepDraft,
        onDiscard: () => set(self, () => (self.adoptedFrom = undefined)),
        onReload: onChanged,
        onSave: async (content, reviewed) => {
          guardMemorySave(locked, memoryDocument(data, place).version, reviewed)
          const saved = await api.call('memory.write', memoryWrite(data, content))
          entry.replace(saved)
          set(self, () => {
            self.binding = bindingAfterSave(saved.id, summary?.id)
            self.adoptedFrom = undefined
          })
          onChanged()
          return memoryDocument(saved, place)
        },
      })
      const deletes = view.deletes
      if (canWrite && deletes) {
        if (self.del && self.del.key !== deletes.entry.id) {
          self.del.alive = false
          self.del = undefined
        }
        self.del ??= {
          key: deletes.entry.id,
          alive: true,
          confirming: false,
          busy: false,
          error: undefined,
        }
        renderDeleteEntry(out, dialogs, self.del, { ...deletes, onDeleted })
      } else if (self.del) {
        self.del.alive = false
        self.del = undefined
      }
    } else {
      if (self.doc) self.doc.alive = false
      if (self.del) self.del.alive = false
      self.doc = undefined
      self.del = undefined
    }
    commit.layout.push(() => (self.row.current = summary))
    commit.passive.push(() => resourceEffect(self.entry))
    if (mounting) commit.passive.push(() => (self.mounted.current = true))
  }

  function renderDocumentEditor(
    out: ScreenNode[],
    commit: Commit,
    self: DocumentEditorState,
    props: {
      document: VersionedDocument
      draftKey: string
      locked: string | undefined
      onAdopt: (() => void) | undefined
      adoption: { busy: boolean; error?: string | undefined } | undefined
      draftNote: string | undefined
      keepDraft: boolean
      onDiscard: () => void
      onReload: () => void
      onSave: (content: string, expectedVersion: string) => Promise<VersionedDocument>
    },
  ) {
    const { document, draftKey, locked, onAdopt } = props
    const stage = self.stage
    const setStage = (next: Stage) => set(self, () => (self.stage = next))
    const restored = keptDrafts.has(draftKey) && stage.kind !== 'view'
    const keep = keptDraft(locked, props.keepDraft, stage)
    // The effect on [draftKey, keep]; it runs before the parents' effects.
    commit.passive.unshift(() => {
      const deps = self.keepDeps
      if (deps && deps[0] === draftKey && deps[1] === keep) return
      self.keepDeps = [draftKey, keep]
      if (keep !== undefined) keptDrafts.set(draftKey, keep)
    })
    const panel = lockPanel({
      locked,
      canAdopt: Boolean(onAdopt),
      stage,
      adoption: props.adoption,
    })
    if (panel) {
      for (const alert of panel.alerts)
        out.push({ kind: 'text', text: alert, role: 'alert', live: 'assertive' })
      if (panel.note) out.push({ kind: 'text', text: panel.note })
      if (panel.busy) out.push({ kind: 'text', text: panel.busy, live: 'polite' })
      if (panel.adopt && onAdopt)
        out.push({
          kind: 'button',
          label: 'Use this draft for the entry now here',
          name: 'Use this draft for the entry now here',
          disabled: panel.adopt.disabled,
          press: onAdopt,
        })
    }
    const notice = draftNotice({ draftNote: props.draftNote, restored, locked })
    const button = (label: string, press: () => void, disabled = false) =>
      out.push({ kind: 'button', label, name: label, disabled, press })

    if (stage.kind === 'view') {
      const previous = previousTextOffer(self.backup, document, locked)
      const backup = self.backup
      out.push({ kind: 'text', text: document.content, tag: 'shown' })
      out.push({
        kind: 'text',
        text: `Read from ${document.source}. Version ${document.version.slice(0, 12)}.`,
      })
      if (previous === 'restore' && backup) {
        out.push({
          kind: 'text',
          text: 'The previous version is kept on this screen until you leave it.',
        })
        button('Restore previous version', () =>
          setStage({ kind: 'edit', draft: backup.content }),
        )
      } else if (previous === 'copy' && backup) {
        out.push({
          kind: 'text',
          text: 'The text your last save replaced, kept on this screen to copy:',
        })
        out.push({ kind: 'text', text: backup.content })
      }
      button('Reload', props.onReload)
      if (canWrite && !locked)
        button('Edit', () =>
          set(self, () => {
            self.failure = undefined
            self.stage = { kind: 'edit', draft: document.content }
          }),
        )
      return
    }

    if (stage.kind === 'edit') {
      if (notice) out.push({ kind: 'text', text: notice, live: 'polite' })
      out.push({
        kind: 'field',
        label: `Edit ${document.key}`,
        value: stage.draft,
        readOnly: Boolean(locked),
        change: (draft) => setStage({ kind: 'edit', draft }),
      })
      button('Discard changes', () => {
        keptDrafts.delete(draftKey)
        set(self, () => {
          self.failure = undefined
          self.stage = { kind: 'view' }
        })
        props.onDiscard()
      })
      button(
        'Review changes',
        () => setStage(reviewStage(stage.draft, document)),
        Boolean(locked) || stage.draft === document.content,
      )
      return
    }

    const { draft, base } = stage
    const moved = reviewMoved(base, document)
    const { lines } = diffLines(document.content, draft)
    const save = async () => {
      set(self, () => {
        self.saving = true
        self.failure = undefined
      })
      try {
        const previous = document.content
        const saved = await props.onSave(draft, base)
        keptDrafts.delete(draftKey)
        set(self, () => {
          self.backup = { content: previous, version: saved.version }
          self.stage = { kind: 'view' }
        })
      } catch (error) {
        if (isCindlError(error) && error.code === 'conflict') {
          keptDrafts.set(draftKey, draft)
          set(
            self,
            () =>
              (self.failure = {
                message: `${error.message} Your draft is kept.`,
                conflict: true,
              }),
          )
        } else {
          const copy = describeFailure(error, SAVE_UNCERTAIN, NOT_APPLIED)
          set(
            self,
            () =>
              (self.failure = {
                message: copy.certain
                  ? `${copy.message} Nothing was saved.`
                  : copy.message,
                conflict: false,
              }),
          )
        }
      } finally {
        set(self, () => (self.saving = false))
      }
    }
    out.push({
      kind: 'text',
      tag: 'changes',
      text: lines
        .map(
          (line) =>
            `${line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}${line.text}`,
        )
        .join('\n'),
    })
    if (moved && !locked)
      out.push({
        kind: 'text',
        role: 'alert',
        live: 'assertive',
        text: 'This text changed in Hermes while you were reviewing, so the changes above are against the new version. Go back to editing and review your draft again before saving.',
      })
    if (self.failure)
      out.push({
        kind: 'text',
        text: self.failure.message,
        role: 'alert',
        live: 'assertive',
      })
    if (self.failure?.conflict)
      button('Reload and keep my draft', () => {
        props.onReload()
        set(self, () => {
          self.failure = undefined
          self.stage = { kind: 'edit', draft }
        })
      })
    button('Back to editing', () => setStage({ kind: 'edit', draft }), self.saving)
    button(
      self.saving ? 'Saving…' : 'Confirm and save',
      () => void save(),
      self.saving || moved || Boolean(locked) || Boolean(self.failure?.conflict),
    )
  }

  function renderDeleteEntry(
    out: ScreenNode[],
    dialogs: ScreenNode[],
    self: DeleteEntryState,
    props: { entry: MemoryEntry; title: string; onDeleted: () => void },
  ) {
    out.push({
      kind: 'button',
      label: 'Delete entry…',
      name: 'Delete entry…',
      disabled: false,
      press: () =>
        set(self, () => {
          self.error = undefined
          self.confirming = true
        }),
    })
    if (!self.confirming) return
    // The Dialog renders in the overlay above the screen.
    const dialog = 'Delete this memory entry?'
    dialogs.push({ kind: 'text', text: dialog, role: 'header', dialog })
    dialogs.push({ kind: 'text', text: deleteWarning(props.title), dialog })
    if (self.error)
      dialogs.push({
        kind: 'text',
        text: self.error,
        role: 'alert',
        live: 'assertive',
        dialog,
      })
    dialogs.push({
      kind: 'button',
      label: 'Keep it',
      name: 'Keep it',
      disabled: self.busy,
      press: () => set(self, () => (self.confirming = false)),
      dialog,
    })
    dialogs.push({
      kind: 'button',
      label: 'Delete permanently',
      name: 'Delete permanently',
      disabled: self.busy,
      dialog,
      press: () => {
        set(self, () => {
          self.busy = true
          self.error = undefined
        })
        api.call('memory.delete', memoryDelete(props.entry)).then(
          () => {
            activity += 1
            set(self, () => {
              self.busy = false
              self.confirming = false
            })
            props.onDeleted()
          },
          (failure: unknown) => {
            activity += 1
            set(self, () => {
              self.busy = false
              self.error = describeFailure(
                failure,
                DELETE_UNCERTAIN,
                DELETE_REFUSED,
              ).message
            })
          },
        )
      },
    })
  }

  /** Renders until nothing changed, committing each render (as an act() flush). */
  function flush() {
    for (let round = 0; dirty; round++) {
      if (round > 50) throw new Error('the screen keeps updating')
      dirty = false
      rendering = true
      let result: ReturnType<typeof renderRoot>
      try {
        result = renderRoot()
      } finally {
        rendering = false
      }
      nodes = [...result.nodes, ...result.dialogs]
      for (const effect of result.commit.layout) effect()
      for (const effect of result.commit.passive) effect()
    }
  }

  function mount() {
    root = {
      alive: true,
      list: resource<MemoryEntrySummary[]>('Memory entries could not be loaded.'),
      open: undefined,
      editor: undefined,
    }
    dirty = true
    flush()
  }

  function unmount() {
    const state = root
    if (!state) return
    root = undefined
    state.alive = false
    unmountResource(state.list)
    if (state.editor) unmountEditor(state.editor)
    nodes = []
  }

  const inDialog = () => nodes.some((node) => node.kind !== 'field' && node.dialog)
  const buttons = (name: string | RegExp) =>
    nodes.filter(
      (node): node is Extract<ScreenNode, { kind: 'button' }> =>
        node.kind === 'button' && matches(node.name, name),
    )
  const texts = () =>
    nodes.filter(
      (node): node is Extract<ScreenNode, { kind: 'text' }> => node.kind === 'text',
    )

  mount()

  const screen = {
    /** Every node on screen, in order. */
    nodes: () => nodes,
    /** Lets every answer that is not held arrive, rendering after each. */
    settle: async () => {
      for (let round = 0; round < 100; round++) {
        const before = activity
        await new Promise<void>((resolve) => setImmediate(resolve))
        flush()
        if (activity === before) return
      }
      throw new Error('the screen never settled')
    },
    /** Leaves the screen and comes back: every component state is new. */
    remount: () => {
      unmount()
      mount()
    },
    unmount,
    button: (name: string | RegExp) => buttons(name)[0],
    buttons,
    /** Presses a button (the nth with this name), as the owner would. */
    press: (name: string | RegExp, nth = 0) => {
      const target = buttons(name)[nth]
      if (!target) throw new Error(`no button ${String(name)}`)
      if (target.disabled) throw new Error(`${String(name)} is disabled`)
      if (inDialog() && !target.dialog)
        throw new Error(`${String(name)} is behind a dialog`)
      target.press()
      flush()
    },
    /** Types into the editor's text field. */
    change: (text: string, label?: string | RegExp) => {
      const target = nodes.find(
        (node): node is Extract<ScreenNode, { kind: 'field' }> =>
          node.kind === 'field' && (label === undefined || matches(node.label, label)),
      )
      if (!target) throw new Error(`no field ${String(label)}`)
      if (target.readOnly) throw new Error(`${target.label} is read-only`)
      if (inDialog()) throw new Error(`${target.label} is behind a dialog`)
      target.change(text)
      flush()
    },
    field: () =>
      nodes.find(
        (node): node is Extract<ScreenNode, { kind: 'field' }> => node.kind === 'field',
      ),
    /** True when a text node equals the string, or matches the pattern. */
    hasText: (match: string | RegExp) =>
      texts().some((node) => matches(node.text, match)),
    alerts: () => texts().flatMap((node) => (node.role === 'alert' ? [node.text] : [])),
    /** Texts TalkBack announces politely (the web's role="status"). */
    polite: () => texts().flatMap((node) => (node.live === 'polite' ? [node.text] : [])),
    /** All text on screen, as the web's document.body.textContent (not field values). */
    body: () =>
      texts()
        .map((node) => node.text)
        .join('\n'),
    shown: () => texts().find((node) => node.tag === 'shown')?.text,
    changes: () => texts().find((node) => node.tag === 'changes')?.text,
    /** The text of an open dialog, title first. */
    dialog: (title: string) => {
      const inside = texts().filter((node) => node.dialog === title)
      return inside.length ? inside.map((node) => node.text).join('\n') : undefined
    },
  }
  return screen
}

export type MemoryScreen = ReturnType<typeof memoryScreen>

// The web probes' fixture (apps/web/test/memory-adoption.test.tsx).
export type Store = 'memory' | 'profile'
export interface Entry {
  store: Store
  content: string
}
export const GLAZE =
  'Glaze supplier calls moved to Thursdays at 10:00 (fictional supplier).'
export const KILN =
  'The kiln firing log lives in the studio inventory sheet, tab "Firings".'
export const HARBOR = 'Harbor Loft (fictional) holds the offsite date until Friday.'
export const BRIEF = 'Prefers a short morning brief, ready before 08:30.'
export const FOCUS = 'Protects focus time before 11:00 on weekdays.'
export const fixtureEntries: Entry[] = [
  { store: 'memory', content: GLAZE },
  { store: 'memory', content: KILN },
  { store: 'memory', content: HARBOR },
  { store: 'profile', content: BRIEF },
  { store: 'profile', content: FOCUS },
]
export const fp = (content: string) => sha256Hex(content.trim()).slice(0, 12)

/** Memory shaped like the fixture: ids resolve by store and fingerprint. */
export function memoryBackend(initial: Entry[]) {
  const entries = initial.map((entry) => ({ ...entry }))
  const ordered = () => [
    ...entries.filter((e) => e.store === 'memory'),
    ...entries.filter((e) => e.store === 'profile'),
  ]
  const idOf = (e: Entry) => `memory:${e.store}:${ordered().indexOf(e)}:${fp(e.content)}`
  const find = (id: string) => {
    const [, store, , f] = id.split(':')
    const e = entries.find((c) => c.store === store && fp(c.content) === f)
    if (!e)
      throw new CindlError(
        'conflict',
        'This memory entry changed since you read it. Reload it and review again.',
      )
    return e
  }
  const byText = (re: RegExp) => {
    const e = entries.find((c) => re.test(c.content))
    if (!e) throw new Error(`no entry matching ${String(re)}`)
    return e
  }
  const now = '2026-11-03T09:00:00.000Z'
  const ops: Record<string, (args: never) => unknown> = {
    'memory.entries': (): MemoryEntrySummary[] =>
      ordered().map((e) => ({
        id: idOf(e),
        store: e.store,
        title: (e.content.split('\n')[0] ?? '').slice(0, 60),
        preview: e.content.slice(0, 1200),
        truncated: e.content.length > 1200,
      })),
    'memory.read': ({ id }: { id: string }): MemoryEntry => {
      const e = find(id)
      return { id, store: e.store, content: e.content, readAt: now, source: 'probe' }
    },
    'memory.write': ({ id, content }: { id: string; content: string }): MemoryEntry => {
      const e = find(id)
      e.content = content
      return { id: idOf(e), store: e.store, content, readAt: now, source: 'probe' }
    },
    'memory.delete': ({ id }: { id: string }) => {
      entries.splice(entries.indexOf(find(id)), 1)
      return { deleted: true }
    },
  }
  return {
    ops,
    add: (store: Store, content: string) => void entries.push({ store, content }),
    remove: (re: RegExp) => void entries.splice(entries.indexOf(byText(re)), 1),
    replace: (re: RegExp, content: string) => void (byText(re).content = content),
    has: (re: RegExp) => entries.some((e) => re.test(e.content)),
    contents: () => ordered().map((e) => `${e.store}: ${e.content.slice(0, 40)}`),
  }
}

export type Gate = 'memory.entries' | 'memory.read' | 'memory.write'

/** The Memory screen on the fixture, with calls that can be held or failed. */
export function harness(initial: Entry[] = fixtureEntries) {
  const mem = memoryBackend(initial)
  const calls: Array<{ name: string; args: unknown }> = []
  const held = new Set<Gate>()
  const releases = new Map<Gate, () => void>()
  let failRead = false
  const call = (async (name: string, args: unknown) => {
    calls.push({ name, args })
    if (held.has(name as Gate)) {
      held.delete(name as Gate)
      await new Promise<void>((resolve) => releases.set(name as Gate, resolve))
    }
    if (name === 'memory.read' && failRead) {
      failRead = false
      throw new CindlError('unavailable', 'Hermes is not answering.')
    }
    const op = mem.ops[name]
    if (!op) throw new Error(`unexpected call ${name}`)
    return op(args as never)
  }) as Call
  const screen = memoryScreen({ call })
  return {
    ...screen,
    mem,
    calls,
    writes: () =>
      calls
        .filter((c) => c.name === 'memory.write')
        .map((c) => c.args as { id: string; content: string }),
    deletes: () =>
      calls
        .filter((c) => c.name === 'memory.delete')
        .map((c) => c.args as { id: string }),
    hold: (gate: Gate) => void held.add(gate),
    release: (gate: Gate) => {
      const resolve = releases.get(gate)
      releases.delete(gate)
      resolve?.()
    },
    failNextRead: () => (failRead = true),
  }
}

export type Harness = ReturnType<typeof harness>

/** Kept memory drafts, oldest first. */
export const keptMemoryDrafts = () =>
  keptDocumentDrafts(MEMORY_DRAFT_PREFIX).map((d) => d.draft)

/** The editor locked: its notice says Cindl cannot tell what happened. */
export const lockedNow = (s: MemoryScreen) =>
  s.alerts().some((alert) => /cannot tell which/.test(alert))

/** Opens the row whose title matches, from the list on screen. */
export async function openEntry(s: MemoryScreen, title: RegExp) {
  await s.settle()
  s.press(new RegExp(`Open memory entry: ${title.source}`))
  await s.settle()
}

/** "Edit", then the draft typed into the field with this label. */
export function editTo(s: MemoryScreen, label: string, text: string) {
  s.press('Edit')
  s.change(text, label)
}

/** Reloads the list from the open editor's view stage, holding the answer. */
export async function holdListAndReload(h: Harness) {
  h.hold('memory.entries')
  h.press('Reload')
  await h.settle()
}

export async function releaseList(h: Harness) {
  h.release('memory.entries')
  await h.settle()
}
