# Artifacts Domain

Clean domain layer for artifact management following Domain-Driven Design (DDD) principles.

## Architecture

```
domain/artifacts/
├── models/                 # Domain entities (immutable value objects)
│   ├── Artifact.js        # Core artifact model
│   └── ExecutionResult.js # Code execution result
├── services/              # Business logic
│   ├── ArtifactService.js         # Core artifact operations
│   ├── ExecutionService.js        # Code execution
│   ├── TraceabilityService.js     # Lineage tracking
│   └── ArtifactStreamHandler.js   # Stream processing
├── repositories/          # Data access
│   └── ArtifactRepository.js      # PostgreSQL persistence
├── validators/            # Validation logic
│   └── ArtifactValidator.js       # Input validation
└── index.js              # Public API
```

## Core Concepts

### Artifact

Immutable value object representing code, output, HTML, or file artifact.

**Properties:**
- `id`: Unique identifier
- `type`: 'code' | 'output' | 'html' | 'file'
- `format`: Language or file extension
- `content`: Artifact content
- `sourceMessageId`: Originating message
- `correlationId`: Request-response correlation
- `chatId`: Parent chat session
- `status`: 'streaming' | 'active' | 'archived' | 'deleted'

**Key Methods:**
- `generateFileName()`: Create filename from properties
- `resolveLanguage()`: Map format to language
- `withStatus(status)`: Create new artifact with updated status
- `withMessageLink(messageId)`: Link to source message
- `toPostgreSQLFormat()`: Serialize for backend

### Services

#### ArtifactService

Core business logic for artifact lifecycle:
- Create from stream data
- Update content during streaming
- Finalize completed artifacts
- Query by ID, chat, message, correlation
- Link artifacts to messages
- Archive/delete artifacts

#### ExecutionService

Safe code execution in isolated Web Worker:
- Execute JavaScript code
- Timeout protection
- Log capture
- Error handling
- Concurrent execution management

#### TraceabilityService

Bidirectional message-artifact relationships:
- Register messages and artifacts
- Link artifacts to messages
- Query by correlation
- Export audit trail
- Maintain indexes

#### ArtifactStreamHandler

Real-time stream processing:
- Buffer accumulation
- Content streaming
- Finalization coordination
- Stream abortion

### Repository

#### ArtifactRepository

PostgreSQL persistence layer:
- Save artifacts
- Load by chat ID
- Update message links
- Cache management

**Storage API Integration:**
```javascript
window.storageAPI.saveArtifact(chatId, artifact)
window.storageAPI.loadArtifacts(chatId)
window.storageAPI.updateArtifactMessageId(oldId, newId, chatId)
```

### Validators

#### ArtifactValidator

Pure validation functions:
- Artifact structure validation
- Type/status validation
- UUID validation
- Content validation
- PostgreSQL persistence validation
- Stream data validation

## Usage Examples

### Creating and Persisting Artifact

```javascript
const { ArtifactService, ArtifactRepository } = require('./domain/artifacts');

// Initialize
const repository = new ArtifactRepository({ storageAPI: window.storageAPI });
const service = new ArtifactService({ repository });

// Create from stream
const artifact = await service.createFromStream({
  id: 'stream_123',
  kind: 'code',
  format: 'python',
  chatId: 'chat-uuid',
  sourceMessageId: 'msg-uuid',
  correlationId: 'corr-uuid'
});

// Update content
service.updateContent(artifact.id, 'print("Hello")\\n');

// Finalize
const finalArtifact = await service.finalizeArtifact(artifact.id);
```

### Executing Code

```javascript
const { ExecutionService } = require('./domain/artifacts');

const executor = new ExecutionService({ timeout: 5000 });

const result = await executor.executeJavaScript(`
  console.log('Hello');
  return 42;
`);

if (result.isSuccess()) {
  console.log('Result:', result.result);
  console.log('Logs:', result.getLogsString());
}
```

### Streaming Artifacts

```javascript
const { ArtifactStreamHandler } = require('./domain/artifacts');

const handler = new ArtifactStreamHandler({ artifactService });

// Stream start
await handler.handleStreamChunk({
  id: 'stream_123',
  kind: 'code',
  format: 'python',
  start: true,
  chatId: 'chat-uuid'
});

// Stream content
await handler.handleStreamChunk({
  id: 'stream_123',
  kind: 'code',
  content: 'print("Hello")'
});

// Stream end
const artifact = await handler.handleStreamChunk({
  id: 'stream_123',
  kind: 'code',
  end: true
});
```

### Querying Artifacts

```javascript
// Get artifacts for chat
const artifacts = await service.getByChat('chat-uuid');

// Get artifacts for message
const messageArtifacts = await service.getByMessage('message-uuid');

// Get by correlation
const correlatedArtifacts = await service.getByCorrelation('corr-uuid');
```

### Traceability

```javascript
const { TraceabilityService } = require('./domain/artifacts');

const traceability = new TraceabilityService();

// Register entities
traceability.registerMessage(message);
traceability.registerArtifact(artifact);

// Query relationships
const artifacts = traceability.getArtifactsForMessage(messageId);
const message = traceability.getMessageForArtifact(artifactId);

// Export audit trail
const trail = traceability.exportAuditTrail({ chatId: 'chat-uuid' });
```

## Validation

All inputs validated before processing:

```javascript
const { ArtifactValidator } = require('./domain/artifacts');

// Validate artifact
const validation = ArtifactValidator.validate(artifactData);
if (!validation.valid) {
  console.error('Validation errors:', validation.errors);
}

// Validate for persistence
const persistenceCheck = ArtifactValidator.validateForPersistence(artifact);

// Validate stream data
const streamCheck = ArtifactValidator.validateStreamData(streamData);

// Validate content
const contentCheck = ArtifactValidator.validateContent(content, {
  maxSize: 10 * 1024 * 1024, // 10MB
  allowEmpty: false
});
```

## Design Principles

1. **Immutability**: All models are immutable value objects
2. **Single Responsibility**: Each class has one clear purpose
3. **Dependency Injection**: Services receive dependencies via constructor
4. **Pure Functions**: Validators are stateless pure functions
5. **Error Handling**: Comprehensive error messages and logging
6. **Type Safety**: Clear interfaces and validation
7. **Testability**: Pure business logic, no DOM dependencies
8. **Separation of Concerns**: Clean layer boundaries

## Integration with Other Domains

**Chat Domain:**
- Links artifacts to source messages
- Coordinates message-artifact persistence
- Provides traceability across conversations

**Infrastructure Layer:**
- Uses StorageAPI for PostgreSQL access
- Uses IPC for cross-window communication
- Uses EventBus for domain events

**Security Layer:**
- Web Worker isolation for code execution
- Content sanitization before persistence
- UUID validation for backend integrity

## Testing

All domain logic testable without DOM:

```javascript
// Unit test example
const artifact = new Artifact({
  id: 'test_1',
  type: 'code',
  format: 'python',
  content: 'print("test")'
});

assert(artifact.resolveLanguage() === 'python');
assert(artifact.generateFileName().includes('code_'));
assert(artifact.isStreamable() === true);
```

## Performance

- In-memory caching for active artifacts
- Repository cache with TTL
- Stream buffer management
- Concurrent execution limits
- Efficient indexing in traceability service

## Security

- Web Worker sandboxing
- Content size limits
- Timeout protection
- UUID validation
- SQL injection prevention (backend)
- No eval or Function constructor in user scope

