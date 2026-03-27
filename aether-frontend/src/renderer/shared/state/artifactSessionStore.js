'use strict';

/**
 * @.architecture
 *
 * Incoming: Renderer artifact events grouped by chat --- {Dict, json}
 * Processing: Maintain in-memory session caches for artifacts per chat --- {2 jobs: JOB_GET_STATE, JOB_UPDATE_STATE}
 * Outgoing: Session snapshots for controllers and viewers --- {Dict, json}
 */

class ArtifactSessionStore {
  constructor() {
    this.sessions = new Map(); // chatId -> Map<artifactId, artifact>
    this.currentChatId = null;
  }

  async init() {
    return true;
  }

  async switchSession(chatId) {
    if (!chatId) {
      return { chatId: null, artifacts: [] };
    }
    this.currentChatId = chatId;
    const artifacts = this.getSessionArtifacts(chatId)?.artifacts || [];
    return { chatId, artifacts };
  }

  getSessionArtifacts(chatId) {
    if (!chatId) {
      return { chatId: null, artifacts: [] };
    }
    const store = this.sessions.get(chatId);
    if (!store) {
      return { chatId, artifacts: [] };
    }
    return {
      chatId,
      artifacts: Array.from(store.values())
    };
  }

  addArtifact(artifact, chatIdOverride = null) {
    if (!artifact || !artifact.id) {
      return;
    }
    const chatId = chatIdOverride || artifact.chatId || this.currentChatId;
    if (!chatId) {
      return;
    }
    if (!this.sessions.has(chatId)) {
      this.sessions.set(chatId, new Map());
    }
    this.sessions.get(chatId).set(artifact.id, { ...artifact });
  }

  getArtifact(artifactId, chatIdOverride = null) {
    if (!artifactId) {
      return null;
    }
    const chatId = chatIdOverride || this.currentChatId;
    if (!chatId || !this.sessions.has(chatId)) {
      return null;
    }
    const store = this.sessions.get(chatId);
    return store.get(artifactId) || null;
  }

  cacheArtifacts(chatId, artifacts = []) {
    if (!chatId) {
      return;
    }
    const map = new Map();
    artifacts.forEach((artifact) => {
      if (artifact && artifact.id) {
        map.set(artifact.id, { ...artifact });
      }
    });
    this.sessions.set(chatId, map);
  }
}

module.exports = {
  ArtifactSessionStore
};
