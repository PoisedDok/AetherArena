'use strict';

/**
 * @.architecture
 * 
 * Incoming: OutputViewer.render() → Media URL string or {url, src, content, type} object --- {artifact_types.image_output | artifact_types.video_output, string}
 * Processing: Detect media type from file extension (jpg/png/gif/webp/svg for image, mp4/webm/ogg for video, mp3/wav for audio), create native HTML5 media elements (img/video/audio) with error handlers --- {2 jobs: JOB_CREATE_DOM_ELEMENT, JOB_UPDATE_STATE}
 * Outgoing: DOM (HTML5 media element with controls) --- {dom_types.chat_entry_element, HTMLElement}
 * 
 * 
 * @module renderer/artifacts/modules/output/renderers/MediaRenderer
 */

const BaseRenderer = require('./BaseRenderer');
const { freeze } = Object;

const CONFIG = freeze({
  CLASS_NAMES: freeze({
    CONTAINER: 'media-renderer-container',
    IMAGE: 'media-image',
    VIDEO: 'media-video',
    AUDIO: 'media-audio',
  }),
  SUPPORTED_TYPES: freeze({
    IMAGE: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'],
    VIDEO: ['mp4', 'webm', 'ogg', 'mov'],
    AUDIO: ['mp3', 'wav', 'ogg', 'aac'],
  }),
});

class MediaRenderer extends BaseRenderer {
  constructor(options = {}) {
    super(options);
  }

  async render(data, container) {
    try {
      const url = typeof data === 'string' ? data : (data.url || data.src || data.content);
      const type = this._detectMediaType(url, data.type);

      if (!url) {
        const emptyEl = this.createEmptyMessage('No media URL provided');
        this.prepareContainer(container);
        container.appendChild(emptyEl);
        return;
      }

      this._injectStyles();
      this.prepareContainer(container);
      container.classList.add(CONFIG.CLASS_NAMES.CONTAINER);

      // Render based on type
      switch (type) {
        case 'image':
          this._renderImage(url, container, data);
          break;
        case 'video':
          this._renderVideo(url, container, data);
          break;
        case 'audio':
          this._renderAudio(url, container, data);
          break;
        default:
          const errorEl = this.createErrorMessage('Unsupported media type');
          container.appendChild(errorEl);
      }

      console.log(`[MediaRenderer] Rendered ${type} content`);

    } catch (error) {
      console.error('[MediaRenderer] Render failed:', error);
      this.handleError(container, error, 'Failed to render media');
    }
  }

  _detectMediaType(url, explicitType) {
    if (explicitType) {
      return explicitType.toLowerCase();
    }

    const ext = url.split('.').pop().toLowerCase();

    if (CONFIG.SUPPORTED_TYPES.IMAGE.includes(ext)) {
      return 'image';
    } else if (CONFIG.SUPPORTED_TYPES.VIDEO.includes(ext)) {
      return 'video';
    } else if (CONFIG.SUPPORTED_TYPES.AUDIO.includes(ext)) {
      return 'audio';
    }

    return 'unknown';
  }

  _renderImage(url, container, data) {
    const img = this.createImage(url, data.alt || 'Media image', {
      className: CONFIG.CLASS_NAMES.IMAGE,
      title: data.title,
    });

    img.onerror = () => {
      const errorEl = this.createErrorMessage('Failed to load image');
      container.innerHTML = '';
      container.appendChild(errorEl);
    };

    container.appendChild(img);
  }

  _renderVideo(url, container, data) {
    const video = document.createElement('video');
    video.className = CONFIG.CLASS_NAMES.VIDEO;
    video.controls = true;
    video.src = url;

    if (data.poster) {
      video.poster = data.poster;
    }

    video.onerror = () => {
      const errorEl = this.createErrorMessage('Failed to load video');
      container.innerHTML = '';
      container.appendChild(errorEl);
    };

    container.appendChild(video);
  }

  _renderAudio(url, container, data) {
    const audio = document.createElement('audio');
    audio.className = CONFIG.CLASS_NAMES.AUDIO;
    audio.controls = true;
    audio.src = url;

    audio.onerror = () => {
      const errorEl = this.createErrorMessage('Failed to load audio');
      container.innerHTML = '';
      container.appendChild(errorEl);
    };

    container.appendChild(audio);
  }

  _injectStyles() {
    const styleId = 'media-renderer-styles';
    const styles = `
      .${CONFIG.CLASS_NAMES.CONTAINER} {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: #f5f5f5;
        min-height: 200px;
      }
      .${CONFIG.CLASS_NAMES.IMAGE} {
        max-width: 100%;
        max-height: 80vh;
        object-fit: contain;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      }
      .${CONFIG.CLASS_NAMES.VIDEO} {
        max-width: 100%;
        max-height: 80vh;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      }
      .${CONFIG.CLASS_NAMES.AUDIO} {
        width: 100%;
        max-width: 500px;
      }
    `;
    this.injectStyles(styleId, styles);
  }
}

module.exports = MediaRenderer;

if (typeof window !== 'undefined') {
  window.MediaRenderer = MediaRenderer;
  console.log('📦 MediaRenderer loaded');
}

