import { typeStreamID } from './utils.js'
import { Document } from './document.js'

import type { DID } from 'dids'
import {
  CreateOpts,
  CeramicApi,
  CeramicCommit,
  Context,
  fetchJson,
  Stream,
  StreamConstructor,
  StreamHandler,
  StreamUtils,
  LoadOpts,
  MultiQuery,
  PinApi,
  UpdateOpts,
  SyncOptions,
  AnchorStatus,
  IndexApi,
  StreamState,
  AdminApi,
  AnchorOpts,
} from '@ceramicnetwork/common'
import { TileDocument } from '@ceramicnetwork/stream-tile'
import { Caip10Link } from '@ceramicnetwork/stream-caip10-link'
import { Model } from '@ceramicnetwork/stream-model'
import { ModelInstanceDocument } from '@ceramicnetwork/stream-model-instance'
import { StreamID, CommitID, StreamRef } from '@ceramicnetwork/streamid'
import { RemoteIndexApi } from './remote-index-api.js'
import { RemoteAdminApi } from './remote-admin-api.js'
import { DummyPinApi } from './dummy-pin-api.js'

const API_PATH = './api/v0/'
const CERAMIC_HOST = 'http://localhost:7007'

/**
 * Default Ceramic client configuration
 */
export const DEFAULT_CLIENT_CONFIG: CeramicClientConfig = {
  syncInterval: 5000,
}

const DEFAULT_APPLY_COMMIT_OPTS = { anchor: true, publish: true, sync: SyncOptions.PREFER_CACHE }
const DEFAULT_CREATE_FROM_GENESIS_OPTS = {
  anchor: true,
  publish: true,
  sync: SyncOptions.PREFER_CACHE,
}
const DEFAULT_LOAD_OPTS = { sync: SyncOptions.PREFER_CACHE }

/**
 * Ceramic client configuration
 */
export interface CeramicClientConfig {
  /**
   * How frequently the http-client polls the daemon for updates to subscribed-to streams, in milliseconds.
   */
  syncInterval: number
}

/**
 * Ceramic client implementation
 */
export class CeramicClient implements CeramicApi {
  // Stored as a member to make it easier to inject a mock in unit tests
  private readonly _fetchJson: typeof fetchJson = fetchJson
  private readonly _apiUrl: URL
  private _supportedChains: Array<string>

  public readonly pin: PinApi
  public readonly admin: AdminApi
  public readonly index: IndexApi
  public readonly context: Context

  private readonly _config: CeramicClientConfig
  public readonly _streamConstructors: Record<number, StreamConstructor<Stream>>

  constructor(apiHost: string = CERAMIC_HOST, config: Partial<CeramicClientConfig> = {}) {
    this._config = { ...DEFAULT_CLIENT_CONFIG, ...config }

    // API_PATH contains leading dot-slash, so preserves the full path
    this._apiUrl = new URL(API_PATH, apiHost)
    this.context = { api: this }

    this.pin = new DummyPinApi()
    this.index = new RemoteIndexApi(this._apiUrl)
    const getDidFn = (() => {
      return this.did
    }).bind(this)
    this.admin = new RemoteAdminApi(this._apiUrl, getDidFn)

    this._streamConstructors = {
      [Caip10Link.STREAM_TYPE_ID]: Caip10Link,
      [Model.STREAM_TYPE_ID]: Model,
      [ModelInstanceDocument.STREAM_TYPE_ID]: ModelInstanceDocument,
      [TileDocument.STREAM_TYPE_ID]: TileDocument,
    }
  }

  get did(): DID | undefined {
    return this.context.did
  }

  /**
   * Sets the DID instance that will be used to author commits to streams.
   * @param did
   */
  set did(did: DID) {
    this.context.did = did
  }

  async createStreamFromGenesis<T extends Stream>(
    type: number,
    genesis: any,
    opts: CreateOpts = {}
  ): Promise<T> {
    opts = { ...DEFAULT_CREATE_FROM_GENESIS_OPTS, ...opts }
    const stream = await Document.createFromGenesis(
      this._apiUrl,
      type,
      genesis,
      opts,
      this._config.syncInterval
    )

    return this.buildStreamFromDocument<T>(stream)
  }

  async loadStream<T extends Stream>(
    streamId: StreamID | CommitID | string,
    opts: LoadOpts = {}
  ): Promise<T> {
    opts = { ...DEFAULT_LOAD_OPTS, ...opts }
    const streamRef = StreamRef.from(streamId)
    const stream = await Document.load(streamRef, this._apiUrl, this._config.syncInterval, opts)
    return this.buildStreamFromDocument<T>(stream)
  }

  async multiQuery(queries: Array<MultiQuery>, timeout?: number): Promise<Record<string, Stream>> {
    const queriesJSON = queries.map((q) => {
      return {
        ...q,
        streamId: typeof q.streamId === 'string' ? q.streamId : q.streamId.toString(),
      }
    })

    const url = new URL('./multiqueries', this._apiUrl)
    const results = await this._fetchJson(url, {
      method: 'POST',
      body: {
        queries: queriesJSON,
        ...{ timeout },
      },
    })

    return Object.entries(results).reduce((acc, e) => {
      const [k, v] = e
      const state = StreamUtils.deserializeState(v)
      const stream = new Document(state, this._apiUrl, this._config.syncInterval)
      acc[k] = this.buildStreamFromDocument(stream)
      return acc
    }, {})
  }

  loadStreamCommits(streamId: string | StreamID): Promise<Record<string, any>[]> {
    const effectiveStreamId = typeStreamID(streamId)
    return Document.loadStreamCommits(effectiveStreamId, this._apiUrl)
  }

  async applyCommit<T extends Stream>(
    streamId: string | StreamID,
    commit: CeramicCommit,
    opts: UpdateOpts = {}
  ): Promise<T> {
    opts = { ...DEFAULT_APPLY_COMMIT_OPTS, ...opts }
    const effectiveStreamId: StreamID = typeStreamID(streamId)
    const document = await Document.applyCommit(
      this._apiUrl,
      effectiveStreamId,
      commit,
      opts,
      this._config.syncInterval
    )

    return this.buildStreamFromDocument<T>(document)
  }

  async requestAnchor(
    streamId: string | StreamID,
    opts: LoadOpts & AnchorOpts = {}
  ): Promise<AnchorStatus> {
    opts = { ...DEFAULT_LOAD_OPTS, ...opts }
    const { anchorStatus } = await this._fetchJson(
      `${this._apiUrl}streams/${streamId.toString()}/anchor`,
      {
        method: 'POST',
        body: {
          opts,
        },
      }
    )

    return anchorStatus
  }

  addStreamHandler<T extends Stream>(streamHandler: StreamHandler<T>): void {
    this._streamConstructors[streamHandler.name] = streamHandler.stream_constructor
  }

  /**
   * Turns +state+ into a Stream instance of the appropriate StreamType.
   * Does not add the resulting instance to a cache.
   * @param state StreamState for a stream.
   */
  buildStreamFromState<T extends Stream = Stream>(state: StreamState): T {
    const stream$ = new Document(state, this._apiUrl, this._config.syncInterval)
    return this.buildStreamFromDocument(stream$) as T
  }

  private buildStreamFromDocument<T extends Stream = Stream>(stream: Document): T {
    const type = stream.state.type
    const streamConstructor = this._streamConstructors[type]
    if (!streamConstructor) throw new Error(`Failed to find constructor for stream ${type}`)
    return new streamConstructor(stream, this.context) as T
  }

  async setDID(did: DID): Promise<void> {
    this.context.did = did
  }

  async getSupportedChains(): Promise<Array<string>> {
    if (this._supportedChains) {
      return this._supportedChains
    }

    // Fetch the chainId from the daemon and cache the result
    const { supportedChains } = await this._fetchJson(new URL('./node/chains', this._apiUrl))
    this._supportedChains = supportedChains
    return supportedChains
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async close(): Promise<void> {}
}
