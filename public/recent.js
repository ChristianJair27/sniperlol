(async function(){
  const $ = (id)=>document.getElementById(id);
  const out = $("out"), meta = $("meta");

  // Cargar Data Dragon para nombres/íconos
  let champById = {};
  async function loadChampions() {
    try {
      const vers = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
      const v = vers[0];
      const data = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`)).json();
      const map = {};
      Object.values(data.data).forEach(ch => {
        map[Number(ch.key)] = {
          name: ch.name,
          icon: `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${ch.image.full}`,
        };
      });
      champById = map;
    } catch(e){
      champById = {};
    }
  }
  await loadChampions();

  function fmtDate(ts){
    try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
  }

  function table(title, rows, showLastPlayed){
    let html = `<div class="section"><div class="pill">${title}</div><table>
      <thead><tr><th>#</th><th>Champion</th><th>Games</th><th>Winrate</th>${showLastPlayed?'<th>Last played</th>':''}</tr></thead><tbody>`;
    rows.forEach((r, i) => {
      const meta = champById[r.championId] || { name: r.championName || ('#'+r.championId), icon: "" };
      html += `<tr>
        <td>${i+1}</td>
        <td>${meta.icon ? `<img class="icon" src="${meta.icon}" alt="">` : ''}${meta.name}</td>
        <td>${r.games}</td>
        <td>${r.winrate}%</td>
        ${showLastPlayed?`<td>${fmtDate(r.lastPlayed)}</td>`:''}
      </tr>`;
    });
    html += `</tbody></table></div>`;
    return html;
  }

  $("btn").onclick = async () => {
    out.innerHTML = "Cargando...";
    meta.textContent = "";

    const riotId = $("riotId").value.trim();
    const puuid   = $("puuid").value.trim();
    const prefer  = $("prefer").value;
    const count   = $("count").value;
    const queues  = $("queues").value.trim();

    const params = new URLSearchParams({ prefer, count });
    if (queues) params.set("queues", queues);
    if (puuid) params.set("puuid", puuid);
    else if (riotId) params.set("riotId", riotId.replace("#","%23"));

    const url = `/api/players/recent-champions?${params.toString()}`;
    const t0 = performance.now();
    try {
      const r = await fetch(url);
      const j = await r.json();
      const t1 = performance.now();

      if (!j.ok) {
        out.innerHTML = `<pre>${JSON.stringify(j, null, 2)}</pre>`;
        return;
      }

      meta.textContent = `PUUID: ${j.puuid} • cluster: ${j.regionCluster} • matches: ${j.matches} • ${Math.round(t1 - t0)}ms`;

      // construir las dos tablas
      const recent = j.recent || [];
      const frequent = j.frequent || [];

      let html = '<div class="grid">';
      html += table("Most recently played", recent.slice(0, 10), true);
      html += table("Most frequent (in range)", frequent.slice(0, 10), false);
      html += '</div>';

      // JSON colapsable para debug
      html += `<details class="section"><summary>JSON</summary><pre>${JSON.stringify(j, null, 2)}</pre></details>`;

      out.innerHTML = html;
    } catch (e) {
      out.innerHTML = `<pre>${e?.message || e}</pre>`;
    }
  };
})();
