import { showStatus, apiInvoke, el } from '../ui.js';

export default class AdminLabelView {
  constructor() {
    this.comments = [];
    this.currentIndex = 0;
    this.filter = 'unlabeled';
    this.buildFilterBar();
    this.bindEvents();
    this.loadComments();
  }

  buildFilterBar() {
    const container = document.getElementById('label-filters');
    container.innerHTML = '';
    const filters = [
      { key: 'unlabeled', label: '未标注' },
      { key: 'all', label: '全部' },
      { key: 'spam', label: '垃圾' },
      { key: 'not-spam', label: '正常' },
    ];
    for (const f of filters) {
      const btn = el('button', {
        className: 'filter-btn' + (f.key === this.filter ? ' active' : ''),
        'data-filter': f.key,
        onClick: (e) => this.setFilter(f.key),
      }, f.label);
      container.appendChild(btn);
    }
  }

  bindEvents() {
    document.getElementById('btn-spam').addEventListener('click', () => this.labelCurrent(1));
    document.getElementById('btn-not-spam').addEventListener('click', () => this.labelCurrent(0));
    document.getElementById('btn-skip').addEventListener('click', () => this.next());
    document.getElementById('btn-prev').addEventListener('click', () => this.prev());
    document.getElementById('btn-next').addEventListener('click', () => this.next());
    document.getElementById('btn-batch-spam').addEventListener('click', () => this.batchLabel(1));
    document.getElementById('btn-batch-not-spam').addEventListener('click', () => this.batchLabel(0));

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('view-label') && !document.getElementById('view-label').classList.contains('active')) return;
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 's' || e.key === 'S') this.labelCurrent(1);
      if (e.key === 'n' || e.key === 'N') this.labelCurrent(0);
      if (e.key === 'ArrowRight') this.next();
      if (e.key === 'ArrowLeft') this.prev();
    });
  }

  async setFilter(filter) {
    this.filter = filter;
    this.currentIndex = 0;
    this.buildFilterBar();
    document.querySelectorAll('.filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === filter);
    });
    await this.loadComments();
  }

  async loadComments() {
    const res = await apiInvoke('labels:get-all', this.filter, 200, 0);
    if (res.success) {
      this.comments = res.comments;
      this.currentIndex = 0;
      this.render();
    }
    const statsRes = await apiInvoke('labels:stats');
    if (statsRes.success) {
      const s = statsRes.stats;
      document.getElementById('label-stats').innerHTML =
        `<span>总计 <strong>${s.total}</strong></span>` +
        `<span>垃圾 <strong style="color:var(--danger)">${s.spam}</strong></span>` +
        `<span>正常 <strong style="color:var(--success)">${s.not_spam}</strong></span>` +
        `<span>待标注 <strong style="color:var(--accent)">${s.unlabeled}</strong></span>`;
    }
  }

  render() {
    const emptyEl = document.getElementById('label-empty');
    const cardEl = document.getElementById('label-card');

    if (this.comments.length === 0) {
      cardEl.style.display = 'none';
      emptyEl.style.display = 'block';
      return;
    }

    cardEl.style.display = 'block';
    emptyEl.style.display = 'none';

    const c = this.comments[this.currentIndex];
    document.getElementById('comment-index').textContent =
      `${this.currentIndex + 1} / ${this.comments.length}`;
    document.getElementById('comment-username').textContent = '@' + c.username;
    document.getElementById('comment-text').textContent = c.text;

    // Show original post text for context
    const postEl = document.getElementById('post-text');
    if (c.post_text) {
      if (!postEl) {
        const commentDisplay = document.querySelector('.comment-display');
        const headerEl = document.querySelector('.comment-header');
        const postDiv = el('div', {
          id: 'post-text',
          style: 'background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:12px;font-size:13px;color:var(--text-muted);max-height:100px;overflow-y:auto'
        });
        const postLabel = el('div', { style: 'font-size:11px;color:var(--text-dim);margin-bottom:4px' }, '📌 原文');
        const postText = el('div', {}, c.post_text);
        postDiv.appendChild(postLabel);
        postDiv.appendChild(postText);
        headerEl.parentNode.insertBefore(postDiv, commentDisplay.querySelector('.comment-body'));
      } else {
        postEl.style.display = 'block';
        postEl.querySelector('div:last-child').textContent = c.post_text;
      }
    } else if (postEl) {
      postEl.style.display = 'none';
    }

    document.getElementById('btn-prev').disabled = this.currentIndex <= 0;
    document.getElementById('btn-next').disabled = this.currentIndex >= this.comments.length - 1;

    // Highlight current label if any
    if (c.label === 1) {
      document.getElementById('btn-spam').style.opacity = '1';
      document.getElementById('btn-not-spam').style.opacity = '0.5';
    } else if (c.label === 0) {
      document.getElementById('btn-spam').style.opacity = '0.5';
      document.getElementById('btn-not-spam').style.opacity = '1';
    } else {
      document.getElementById('btn-spam').style.opacity = '1';
      document.getElementById('btn-not-spam').style.opacity = '1';
    }
  }

  async labelCurrent(label) {
    if (this.comments.length === 0) return;
    const c = this.comments[this.currentIndex];
    await apiInvoke('labels:set', c.id, label);
    c.label = label;

    if (this.filter === 'unlabeled') {
      this.comments.splice(this.currentIndex, 1);
      if (this.currentIndex >= this.comments.length) this.currentIndex = Math.max(0, this.comments.length - 1);
    }
    const statsRes = await apiInvoke('labels:stats');
    if (statsRes.success) {
      const s = statsRes.stats;
      document.getElementById('label-stats').innerHTML =
        `<span>总计 <strong>${s.total}</strong></span>` +
        `<span>垃圾 <strong style="color:var(--danger)">${s.spam}</strong></span>` +
        `<span>正常 <strong style="color:var(--success)">${s.not_spam}</strong></span>` +
        `<span>待标注 <strong style="color:var(--accent)">${s.unlabeled}</strong></span>`;
    }
    this.render();
  }

  next() {
    if (this.currentIndex < this.comments.length - 1) { this.currentIndex++; this.render(); }
  }
  prev() {
    if (this.currentIndex > 0) { this.currentIndex--; this.render(); }
  }

  async batchLabel(label) {
    if (this.comments.length === 0) return;
    const ids = this.comments.map(c => c.id);
    await apiInvoke('labels:batch-set', ids, label);
    for (const c of this.comments) c.label = label;
    if (this.filter === 'unlabeled') { this.comments = []; this.currentIndex = 0; }
    this.render();
    const s = await apiInvoke('labels:stats');
    if (s.success) {
      document.getElementById('label-stats').innerHTML =
        `<span>总计 <strong>${s.stats.total}</strong></span>` +
        `<span>垃圾 <strong style="color:var(--danger)">${s.stats.spam}</strong></span>` +
        `<span>正常 <strong style="color:var(--success)">${s.stats.not_spam}</strong></span>` +
        `<span>待标注 <strong style="color:var(--accent)">${s.stats.unlabeled}</strong></span>`;
    }
  }
}
