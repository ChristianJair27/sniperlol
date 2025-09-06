const $ = (id)=>document.getElementById(id);
$("run").onclick = async () => {
  const riotId = encodeURIComponent($("riotId").value.trim());
  const probe  = encodeURIComponent($("probe").value.trim());
  $("out").textContent = "Consultando...";
  try {
    const res = await fetch(`/api/debug/riot?riotId=${riotId}&probe=${probe}`);
    const json = await res.json();
    $("out").textContent = JSON.stringify(json, null, 2);
  } catch (e) {
    $("out").textContent = "Error: " + e;
  }
};