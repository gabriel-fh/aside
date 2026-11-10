// Markdown minimo e seguro: todo texto e escapado antes de virar HTML.
(function () {
  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  }

  function render(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    const out = [];
    let para = [];
    let list = null;

    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flushPara();
        flushList();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flushPara();
        flushList();
        const level = Math.min(heading[1].length + 1, 5);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }
      const item = line.match(/^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/);
      if (item) {
        flushPara();
        const tag = item[1] ? 'ul' : 'ol';
        if (!list || list.tag !== tag) {
          flushList();
          list = { tag, items: [] };
        }
        list.items.push(item[3]);
        continue;
      }
      if (!line.trim()) {
        flushPara();
        flushList();
        continue;
      }
      flushList();
      para.push(line);
    }
    flushPara();
    flushList();
    return out.join('');
  }

  window.renderMarkdown = render;
})();
