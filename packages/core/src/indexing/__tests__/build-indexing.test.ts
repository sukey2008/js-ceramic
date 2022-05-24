import tmp from 'tmp-promise'
import { buildIndexing, UnsupportedDatabaseProtocolError } from '../build-indexing.js'
import { SqliteIndexApi } from '../sqlite-index-api.js'

describe('sqlite', () => {
  let databaseFolder: tmp.DirectoryResult

  beforeEach(async () => {
    databaseFolder = await tmp.dir()
  })

  afterEach(async () => {
    await databaseFolder.cleanup()
  })

  test('build for sqlite connection string', () => {
    const databaseUrl = new URL(`sqlite://${databaseFolder.path}/database.sqlite`)
    const indexingApi = buildIndexing({
      db: databaseUrl.href,
      models: [],
    })
    expect(indexingApi).toBeInstanceOf(SqliteIndexApi)
  })
  test('build for sqlite3 connection string', () => {
    const databaseUrl = new URL(`sqlite3://${databaseFolder.path}/database.sqlite`)
    const indexingApi = buildIndexing({
      db: databaseUrl.href,
      models: [],
    })
    expect(indexingApi).toBeInstanceOf(SqliteIndexApi)
  })
})

test('throw on unsupported protocol', () => {
  const connectionString = 'garbage://host:3000/database'
  expect(() => buildIndexing({ db: connectionString, models: [] })).toThrow(
    UnsupportedDatabaseProtocolError
  )
})
test('throw on non-url connection string', () => {
  const connectionString = `/absolute/path/to/database.sqlite`
  expect(() => buildIndexing({ db: connectionString, models: [] })).toThrow()
})
