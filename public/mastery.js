(async function(){
  const $ = (id)=>document.getElementById(id);
  const out = $("out");

  // Carga mapa de campeones desde Data Dragon (para mostrar nombres/íconos)
  let champById = {};
  async function loadChampions() {
    try {
      const vers = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
      const v = vers[0];
      const data = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`)).json();
      const map = {};
      Object.values(data.data).forEach(ch => {
        map[Number(ch.key)] = { name: ch.name, icon: `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${ch.image.full}` };
      });
      champById = map;
    } catch {
      champById = {};
    }
  }
  await loadChampions();

  function fmtDate(ts){
    try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
  }

  $("btn").onclick = async () => {
    out.innerHTML = "Cargando...";
    const riotId = $("riotId").value.trim();
    const puuid = $("puuid").value.trim();
    const platform = $("platform").value;
    const top = $("top").value;

    const params = new URLSearchParams({ platform, top });
    if (puuid) params.set("puuid", puuid);
    else if (riotId) params.set("riotId", riotId.replace("#","%23"));

    const url = `/api/debug/mastery?${params.toString()}`;

    try {
      const r = await fetch(url);
      const j = await r.json();

      if (!j.ok) {
        out.innerHTML = `<pre>${JSON.stringify(j, null, 2)}</pre>`;
        return;
      }

      // tabla bonita
      let html = `
        <div class="muted">Platform: ${j.platform} • PUUID: ${j.puuid} • Entries: ${j.count} • Top mostrados: ${j.top}</div>
        <table><thead>
          <tr><th>#</th><th>Champion</th><th>Level</th><th>Points</th><th>Last Played</th></tr>
        </thead><tbody>
      `;
      j.items.forEach((it, idx) => {
        const meta = champById[it.championId] || { name: `#${it.championId}`, icon: "" };
        html += `
          <tr>
            <td>${idx+1}</td>
            <td>${meta.icon ? `<img class="icon" src="${meta.icon}" alt="">` : ""}${meta.name}</td>
            <td>${it.championLevel}</td>
            <td>${it.championPoints.toLocaleString()}</td>
            <td>${fmtDate(it.lastPlayTime)}</td>
          </tr>
        `;
      });
      html += "</tbody></table>";

      // JSON crudo (debug)
      html += `<details style="margin-top:12px"><summary>JSON</summary><pre>${JSON.stringify(j, null, 2)}</pre></details>`;

      out.innerHTML = html;

    } catch (e) {
      out.innerHTML = `<pre>${e?.message || e}</pre>`;
    }
  };
})();
