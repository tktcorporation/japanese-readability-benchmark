// 人手評価画面。ペアを 1 つずつ表示し、左右をランダムに入れ替えて投票を集める。
(() => {
  const $ = (id) => document.getElementById(id);

  function getRaterId() {
    try {
      let id = localStorage.getItem("raterId");
      if (!id) {
        id = Math.random().toString(36).slice(2, 10);
        localStorage.setItem("raterId", id);
      }
      return id;
    } catch {
      return "anon-" + Math.random().toString(36).slice(2, 8);
    }
  }

  const raterId = getRaterId();
  $("rater-id").textContent = raterId;
  $("reset").addEventListener("click", () => {
    try { localStorage.removeItem("raterId"); } catch {}
    location.reload();
  });

  let queue = [];
  let total = 0;
  let answered = 0;
  let current = null;
  let leftWasA = true;
  let shownAt = 0;
  // 送信中はボタンもキー入力も受け付けない（二重投票の防止）
  let pending = false;

  function setProgress() {
    const done = total - queue.length - (current ? 1 : 0);
    $("progress-text").textContent = `${done} / ${total} 件`;
    $("progress-bar").style.width = total ? `${(done / total) * 100}%` : "0";
  }

  function show() {
    current = queue.shift() ?? null;
    if (!current) {
      $("main").hidden = true;
      $("done").hidden = false;
      $("done-count").textContent = `（${answered} 件回答）`;
      setProgress();
      return;
    }
    leftWasA = Math.random() < 0.5;
    $("task-title").textContent = current.taskTitle;
    $("task-audience").textContent = current.audience || "一般的な読者";
    $("text-left").textContent = leftWasA ? current.aText : current.bText;
    $("text-right").textContent = leftWasA ? current.bText : current.aText;
    $("comment").value = "";
    for (const el of document.querySelectorAll(".text")) el.scrollTop = 0;
    window.scrollTo({ top: 0 });
    shownAt = Date.now();
    setProgress();
  }

  async function vote(side) {
    if (!current || pending) return;
    pending = true;
    const choice = side === "tie" ? "tie" : (side === "left") === leftWasA ? "A" : "B";
    const buttons = document.querySelectorAll(".choice");
    for (const b of buttons) b.disabled = true;
    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairId: current.id,
          choice,
          leftWasA,
          raterId,
          comment: $("comment").value.trim() || undefined,
          seconds: Math.round((Date.now() - shownAt) / 1000),
        }),
      });
      if (res.status === 409) {
        // すでに記録済み（別タブなど）。次へ進む
        show();
        return;
      }
      if (res.status === 403) {
        // 評価者ごとの上限に達した（別タブで回答済みなど）。終了画面へ
        queue = [];
        current = null;
        show();
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      answered += 1;
      show();
    } catch (err) {
      alert("送信に失敗しました: " + err.message);
    } finally {
      pending = false;
      for (const b of buttons) b.disabled = false;
    }
  }

  for (const b of document.querySelectorAll(".choice")) {
    b.addEventListener("click", () => vote(b.dataset.choice));
  }
  document.addEventListener("keydown", (e) => {
    if (e.target && e.target.tagName === "INPUT") return;
    if (e.key === "1") vote("left");
    else if (e.key === "2") vote("right");
    else if (e.key === "0") vote("tie");
  });

  fetch(`/api/pairs?rater=${encodeURIComponent(raterId)}`)
    .then((r) => r.json())
    .then((data) => {
      queue = data.pairs;
      total = data.pairs.length;
      $("main").hidden = false;
      show();
    })
    .catch((err) => {
      $("progress-text").textContent = "読み込みに失敗しました: " + err.message;
    });
})();
