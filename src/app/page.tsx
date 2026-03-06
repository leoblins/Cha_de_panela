"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { QRCodeCanvas } from "qrcode.react";

type ItemCha = {
  id: string;
  categoria: string;
  nome: string;
  descricao: string | null;
  preco_sugerido: number | null;
  link_compra: string | null;
  imagem_url: string | null;
  status: "disponivel" | "comprado" | string;

  comprador_nome?: string | null;
  repetivel?: boolean;
  aba?: "lista" | "pix" | string;
};

type Confirmacao = {
  id: string;
  nome: string;
  created_at: string;
};

function formatBRL(v: number | null) {
  if (v == null) return "";
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Pix EMV helpers */
function formatAmountForPix(v: number) {
  return v.toFixed(2);
}
function toLen2(n: number) {
  return String(n).padStart(2, "0");
}
function parseTLV(payload: string) {
  const fields: { tag: string; value: string }[] = [];
  let i = 0;
  while (i + 4 <= payload.length) {
    const tag = payload.slice(i, i + 2);
    const len = parseInt(payload.slice(i + 2, i + 4), 10);
    const value = payload.slice(i + 4, i + 4 + len);
    fields.push({ tag, value });
    i = i + 4 + len;
  }
  return fields;
}
function buildTLV(fields: { tag: string; value: string }[]) {
  return fields.map((f) => `${f.tag}${toLen2(f.value.length)}${f.value}`).join("");
}
function crc16ccittFalse(str: string) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
function makePixEmvWithAmount(emvBase: string, amount: number) {
  const fields = parseTLV(emvBase);
  const without54and63 = fields.filter((f) => f.tag !== "54" && f.tag !== "63");
  const amountField = { tag: "54", value: formatAmountForPix(amount) };

  let inserted = false;
  const rebuilt: { tag: string; value: string }[] = [];
  for (const f of without54and63) {
    rebuilt.push(f);
    if (!inserted && f.tag === "53") {
      rebuilt.push(amountField);
      inserted = true;
    }
  }
  if (!inserted) rebuilt.push(amountField);

  const payloadNoCrc = buildTLV(rebuilt);
  const payloadForCrc = payloadNoCrc + "6304";
  const crc = crc16ccittFalse(payloadForCrc);
  return payloadForCrc + crc;
}

type TabKey = "lista" | "pix" | "confirmacao";

export default function Home() {
  const [tab, setTab] = useState<TabKey>("lista");

  const [itens, setItens] = useState<ItemCha[]>([]);
  const [busca, setBusca] = useState("");
  const [categoriasAbertas, setCategoriasAbertas] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const pixEmvBase = process.env.NEXT_PUBLIC_PIX_EMV ?? "";

  // Modal Pix
  const [pixItem, setPixItem] = useState<ItemCha | null>(null);
  const [copiado, setCopiado] = useState(false);

  // Pix valor livre
  const [pixValorLivre, setPixValorLivre] = useState<string>("");

  // Confirmação compra item
  const [confirmItem, setConfirmItem] = useState<ItemCha | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  // Identificação
  const [identifyOpen, setIdentifyOpen] = useState(false);
  const [identifyNome, setIdentifyNome] = useState("");
  const [identifySaving, setIdentifySaving] = useState(false);

  // QR responsivo
  const [qrSize, setQrSize] = useState(220);
  useEffect(() => {
    const update = () => setQrSize(window.innerWidth < 420 ? 180 : 220);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const [pendingAction, setPendingAction] = useState<
    | { kind: "comprar_item"; item: ItemCha }
    | { kind: "pix_item"; item: ItemCha; valor: number }
    | { kind: "pix_livre"; valor: number }
    | null
  >(null);

  // ✅ CONFIRMAÇÕES (3ª aba)
  const [confirmacoes, setConfirmacoes] = useState<Confirmacao[]>([]);
  const [confirmNome, setConfirmNome] = useState("");
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [confirmSaving, setConfirmSaving] = useState(false);
  const [confirmLoadingList, setConfirmLoadingList] = useState(false);

  async function carregarConfirmacoes() {
    setConfirmLoadingList(true);
    const { data, error } = await supabase
      .from("confirmacoes_cha")
      .select("id,nome,created_at")
      .order("created_at", { ascending: false });

    setConfirmLoadingList(false);

    if (error) {
      setConfirmMsg("Não consegui carregar as confirmações.");
      return;
    }

    setConfirmacoes((data ?? []) as Confirmacao[]);
  }

  async function enviarConfirmacao() {
    const nome = confirmNome.trim();
    if (nome.length < 2) {
      setConfirmMsg("Digite seu nome (mín. 2 letras).");
      return;
    }
    if (nome.length > 60) {
      setConfirmMsg("Nome muito grande (máx. 60).");
      return;
    }

    setConfirmSaving(true);
    setConfirmMsg(null);

    const { error } = await supabase.from("confirmacoes_cha").insert({ nome });

    setConfirmSaving(false);

    if (error) {
      setConfirmMsg("Não consegui confirmar agora. Tente novamente.");
      return;
    }

    setConfirmNome("");
    setConfirmMsg("Presença confirmada! ✅ Obrigado 😊");
    await carregarConfirmacoes();
    setTimeout(() => setConfirmMsg(null), 2000);
  }

  async function carregar() {
    setLoading(true);
    setErro(null);

    const { data, error } = await supabase
      .from("itens_cha")
      .select(
        "id,categoria,nome,descricao,preco_sugerido,link_compra,imagem_url,status,categoria_ordem,comprador_nome,repetivel,aba"
      )
      .order("categoria_ordem", { ascending: true })
      .order("nome", { ascending: true });

    if (error) {
      setErro(error.message);
      setItens([]);
      setLoading(false);
      return;
    }

    const rows = (data ?? []) as ItemCha[];
    setItens(rows);

    setCategoriasAbertas((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<string, boolean> = {};
      for (const it of rows.filter((r) => (r.aba ?? "lista") === "lista")) next[it.categoria] = false; // fechadas
      return next;
    });

    setLoading(false);
  }

  useEffect(() => {
    carregar();
  }, []);

  useEffect(() => {
    if (tab === "confirmacao") carregarConfirmacoes();
  }, [tab]);

  const itensDaAba = useMemo(() => {
    return itens.filter((it) => ((it.aba ?? "lista") as "lista" | "pix") === tab);
  }, [itens, tab]);

  const itensFiltrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return itensDaAba;

    return itensDaAba.filter((it) => {
      const hay = `${it.nome} ${it.descricao ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [itensDaAba, busca]);

  const porCategoria = useMemo(() => {
    const map = new Map<string, ItemCha[]>();
    for (const it of itensFiltrados) {
      if (!map.has(it.categoria)) map.set(it.categoria, []);
      map.get(it.categoria)!.push(it);
    }

    for (const [cat, arr] of map.entries()) {
      arr.sort((a, b) => {
        const aRep = !!a.repetivel;
        const bRep = !!b.repetivel;
        if (aRep !== bRep) return aRep ? -1 : 1;

        const aCompr = a.status === "comprado" ? 1 : 0;
        const bCompr = b.status === "comprado" ? 1 : 0;
        if (aCompr !== bCompr) return aCompr - bCompr;

        return a.nome.localeCompare(b.nome);
      });
      map.set(cat, arr);
    }

    return map;
  }, [itensFiltrados]);

  function toggleCategoria(cat: string) {
    setCategoriasAbertas((prev) => ({ ...prev, [cat]: !prev[cat] }));
  }

  function currentEmv(amount: number | null) {
    if (!pixEmvBase) return "";
    if (amount == null) return "";
    return makePixEmvWithAmount(pixEmvBase, Number(amount));
  }

  async function copiarTexto(txt: string) {
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      alert("Não consegui copiar automaticamente.");
    }
  }

  async function efetivarCompraItem(item: ItemCha, nome: string | null) {
    setConfirmLoading(true);

    const { error } = await supabase
      .from("itens_cha")
      .update({ status: "comprado", comprador_nome: nome })
      .eq("id", item.id);

    setConfirmLoading(false);

    if (error) {
      alert("Não consegui marcar como comprado: " + error.message);
      return;
    }

    setItens((prev) =>
      prev.map((it) => (it.id === item.id ? { ...it, status: "comprado", comprador_nome: nome } : it))
    );
  }

  async function registrarPix(itemId: string | null, valor: number, nome: string | null) {
    const { error } = await supabase.from("pix_contribuicoes").insert({
      item_id: itemId,
      valor,
      nome,
    });

    if (error) {
      alert("Não consegui registrar o Pix: " + error.message);
      return;
    }
  }

  function abrirIdentificacao(action: NonNullable<typeof pendingAction>) {
    setPendingAction(action);
    setIdentifyOpen(true);
    setIdentifyNome("");
  }

  function resetIdentifyFlow() {
    setIdentifyOpen(false);
    setIdentifyNome("");
    setPendingAction(null);
  }

  async function finalizarComNomeOuNao(nome: string | null) {
    if (!pendingAction) return;

    setIdentifySaving(true);
    try {
      if (pendingAction.kind === "comprar_item") {
        await efetivarCompraItem(pendingAction.item, nome);
      }

      if (pendingAction.kind === "pix_item") {
        await registrarPix(pendingAction.item.id, pendingAction.valor, nome);

        const rep = !!pendingAction.item.repetivel;
        if (!rep) {
          await efetivarCompraItem(pendingAction.item, nome);
        }
      }

      if (pendingAction.kind === "pix_livre") {
        await registrarPix(null, pendingAction.valor, nome);
      }

      resetIdentifyFlow();
    } finally {
      setIdentifySaving(false);
    }
  }

  return (
    <main className="relative min-h-screen">
      {/* FUNDO */}
      <div
        className="fixed inset-0 -z-10"
        style={{
          backgroundImage: "url('/bg.jpg')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: "blur(10px) brightness(0.75)",
          transform: "scale(1.05)",
        }}
      />

      <div className="mx-auto max-w-5xl px-3 sm:px-4 py-8 sm:py-10">
        {/* HEADER */}
        <header className="mb-5 sm:mb-8 text-center text-white">
          <h1 className="text-3xl sm:text-4xl font-bold drop-shadow-lg">Chá de Panela 💍</h1>
          <p className="mt-2 text-xs sm:text-sm opacity-90">
            Escolha um item e, depois de comprar ou fazer o Pix, marque como <b>comprado 😊</b>.
          </p>
        </header>

        {/* TABS (3 abas) */}
        <div className="mx-auto mb-4 sm:mb-6 max-w-3xl">
          <div className="grid grid-cols-3 rounded-2xl bg-white/95 p-1 shadow backdrop-blur">
            <button
              onClick={() => setTab("lista")}
              className={[
                "rounded-xl py-2 text-sm font-semibold",
                tab === "lista" ? "bg-black text-white" : "text-gray-900 hover:bg-gray-100",
              ].join(" ")}
            >
              Lista de itens
            </button>
            <button
              onClick={() => setTab("pix")}
              className={[
                "rounded-xl py-2 text-sm font-semibold",
                tab === "pix" ? "bg-black text-white" : "text-gray-900 hover:bg-gray-100",
              ].join(" ")}
            >
              Para não dizer que não dei nada
            </button>
            <button
              onClick={() => setTab("confirmacao")}
              className={[
                "rounded-xl py-2 text-sm font-semibold",
                tab === "confirmacao" ? "bg-black text-white" : "text-gray-900 hover:bg-gray-100",
              ].join(" ")}
            >
              Presença/ Loc
            </button>
          </div>
        </div>

        {/* BUSCA (só nas abas lista/pix) */}
        {tab !== "confirmacao" && (
          <div className="mx-auto mb-6 sm:mb-8 max-w-3xl">
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={tab === "pix" ? "Buscar (Pix)..." : "Buscar item..."}
              className="w-full rounded-xl bg-white/95 px-4 py-3 text-sm shadow outline-none focus:ring-2 focus:ring-white/60 text-gray-900 placeholder:text-gray-500"
            />
          </div>
        )}

        {loading && <p className="text-sm text-white/90">Carregando...</p>}
        {erro && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">Erro: {erro}</div>
        )}

        {/* ✅ ABA 3: CONFIRMAÇÃO */}
        {tab === "confirmacao" && (
          <section className="mx-auto max-w-3xl rounded-2xl bg-white/95 shadow-lg backdrop-blur overflow-hidden">
            <div className="p-5 sm:p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">Confirmação de presença ✅</h2>
              <p className="mt-1 text-sm text-gray-700">
                Confirme seu nome abaixo para sabermos quem vai 😊
              </p>
            </div>

            {/* Foto do local */}
            <div className="p-5 sm:p-6">
              <div className="rounded-2xl overflow-hidden border border-gray-200 bg-gray-50">
                {/* Coloque sua foto em public/local.jpg */}
                <img
                  src="/local.jpg"
                  alt="Local do evento"
                  className="w-full h-56 sm:h-72 object-cover"
                />
              </div>

              {/* Endereço */}
              <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4">
                <p className="text-sm font-semibold text-gray-900">📍 Sede de Lazer Sind-Justiça</p>
                <p className="mt-1 text-sm text-gray-700">
                  {/* TROQUE AQUI PELO SEU ENDEREÇO */}
                  Est. Muriqui Pequeno, 25 - Vila Progresso, Niterói - RJ
                </p>
              </div>

              {/* Form confirmar */}
              <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4">
                <p className="text-sm font-semibold text-gray-900">Coloque seu nome</p>
                <div className="mt-3 flex flex-col sm:flex-row gap-2">
                  <input
                    value={confirmNome}
                    onChange={(e) => setConfirmNome(e.target.value)}
                    placeholder="Ex: Cristiano Ronaldo"
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm outline-none focus:border-gray-400 text-gray-900 placeholder:text-gray-500"
                  />
                  <button
                    onClick={enviarConfirmacao}
                    disabled={confirmSaving}
                    className={[
                      "rounded-xl px-4 py-3 text-sm font-semibold text-white",
                      confirmSaving ? "bg-green-300" : "bg-green-600 hover:opacity-90",
                    ].join(" ")}
                  >
                    {confirmSaving ? "Enviando..." : "Confirmar ✅"}
                  </button>
                </div>

                {confirmMsg && (
                  <p className="mt-2 text-sm font-semibold text-gray-900">{confirmMsg}</p>
                )}
              </div>

              {/* Lista confirmados */}
              <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-900">
                    Confirmados ({confirmacoes.length})
                  </p>
                  <button
                    onClick={carregarConfirmacoes}
                    className="text-sm font-semibold text-gray-700 hover:underline"
                  >
                    Atualizar
                  </button>
                </div>

                {confirmLoadingList ? (
                  <p className="mt-3 text-sm text-gray-700">Carregando...</p>
                ) : confirmacoes.length === 0 ? (
                  <p className="mt-3 text-sm text-gray-700">Ainda ninguém confirmou.</p>
                ) : (
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {confirmacoes.map((c) => (
                      <div
                        key={c.id}
                        className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900"
                      >
                        {c.nome}
                      </div>
                    ))}
                  </div>
                )}

                <p className="mt-3 text-xs text-gray-600">
                  Obs: se alguém escrever errado ou não for mais, nos avise que ajustamos/removemos depois 😊
                </p>
              </div>
            </div>
          </section>
        )}

        {/* ABA PIX LIVRE + LISTA / PIX (mantém seu comportamento atual) */}
        {tab === "pix" && (
          <section className="mb-6 rounded-2xl bg-white/95 shadow-lg backdrop-blur">
            <div className="px-5 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Pix de valor livre</h2>
              <p className="text-xs text-gray-700 mt-1">
                Escolha qualquer valor (não some, pode ser usado por várias pessoas).
              </p>
            </div>

            <div className="p-5">
              <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
                <input
                  value={pixValorLivre}
                  onChange={(e) => setPixValorLivre(e.target.value)}
                  inputMode="decimal"
                  placeholder="Ex: 35.00"
                  className="w-full sm:w-56 rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm outline-none focus:border-gray-400 text-gray-900 placeholder:text-gray-500"
                />
                <button
                  onClick={() => {
                    const n = Number(String(pixValorLivre).replace(",", "."));
                    if (!isFinite(n) || n <= 0) {
                      alert("Digite um valor válido. Ex: 35.00");
                      return;
                    }
                    setPixItem({
                      id: "pix-livre",
                      categoria: "Pix livre",
                      nome: "Pix de valor livre",
                      descricao: null,
                      preco_sugerido: n,
                      link_compra: null,
                      imagem_url: null,
                      status: "disponivel",
                      repetivel: true,
                      aba: "pix",
                    });
                  }}
                  className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:opacity-90"
                >
                  Gerar Pix
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-700">Use ponto ou vírgula (ex: 35.00 ou 35,00).</p>
            </div>
          </section>
        )}

        {/* CATEGORIAS (só em lista/pix) */}
        {tab !== "confirmacao" && (
          <div className="space-y-6">
            {[...porCategoria.entries()].map(([cat, lista]) => {
              const aberta = categoriasAbertas[cat] ?? true;
              const isPixTab = tab === "pix";
              const abertaFinal = isPixTab ? true : aberta;

              return (
                <section key={cat} className="rounded-2xl bg-white/95 shadow-lg backdrop-blur">
                  <div className="flex w-full items-center justify-between px-5 py-4">
                    <div className="text-left">
                      <h2 className="text-lg font-semibold text-gray-900">
                        {cat} ({lista.length})
                      </h2>
                    </div>

                    {!isPixTab && (
                      <button
                        onClick={() => toggleCategoria(cat)}
                        className="text-xl font-bold text-gray-900 w-10 h-10 rounded-xl hover:bg-black/5"
                        aria-label="Abrir/fechar categoria"
                      >
                        {aberta ? "−" : "+"}
                      </button>
                    )}
                  </div>

                  {abertaFinal && (
                    <div className="px-4 sm:px-5 pb-5">
                      <div className="grid grid-cols-2 min-[480px]:grid-cols-3 gap-3 sm:gap-4 sm:grid-cols-3 lg:grid-cols-4">
                        {lista.map((it) => {
                          const repetivel = !!it.repetivel;
                          const comprado = it.status === "comprado";
                          const desabilitar = tab === "pix" ? false : comprado;

                          const cardClass = [
                            "overflow-hidden rounded-2xl border bg-white shadow-sm",
                            comprado && !repetivel ? "border-green-200 ring-1 ring-green-200" : "border-gray-200",
                          ].join(" ");

                          return (
                            <div key={it.id} className={cardClass}>
                              {comprado && !repetivel && <div className="h-1 w-full bg-green-500" />}

                              <div className="relative aspect-square w-full bg-gray-100">
                                {comprado && !repetivel && (
                                  <div className="absolute right-2 top-2 z-10 rounded-full bg-green-600/95 px-2.5 py-1 text-[11px] font-semibold text-white shadow">
                                    ✅ Comprado
                                  </div>
                                )}

                                {it.imagem_url ? (
                                  <img
                                    src={it.imagem_url}
                                    alt={it.nome}
                                    className={[
                                      "h-full w-full object-cover",
                                      comprado && !repetivel ? "opacity-90 saturate-75" : "opacity-100",
                                    ].join(" ")}
                                  />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center text-xs text-gray-600">
                                    Sem imagem
                                  </div>
                                )}
                              </div>

                              <div className="p-2 sm:p-3">
                                <div className="min-h-[34px]">
                                  <p className="text-[13px] sm:text-sm font-semibold leading-snug text-gray-900">
                                    {it.nome}
                                  </p>
                                </div>

                                <div className="mt-2 flex items-start justify-between gap-2">
                                  <p className="text-[12px] sm:text-sm font-semibold text-gray-900">
                                    {formatBRL(it.preco_sugerido)}
                                  </p>

                                  {repetivel ? (
                                    <p className="text-[11px] sm:text-xs font-semibold text-gray-800">✨ Pix</p>
                                  ) : (
                                    <div className="text-right">
                                      <p
                                        className={[
                                          "text-[11px] sm:text-xs font-semibold",
                                          comprado ? "text-green-700" : "text-gray-800",
                                        ].join(" ")}
                                      >
                                        {comprado ? "😊 Comprado" : "😢 Não comprado"}
                                      </p>

                                      {comprado && it.comprador_nome ? (
                                        <p className="text-[11px] text-gray-700">por {it.comprador_nome}</p>
                                      ) : null}
                                    </div>
                                  )}
                                </div>

                                {comprado && !repetivel && it.comprador_nome ? (
                                  <div className="mt-2 rounded-xl bg-green-50 px-2 py-1.5 text-[11px] font-semibold text-green-800">
                                    🎁 Presente de {it.comprador_nome}
                                  </div>
                                ) : null}

                                <div className="mt-3 grid grid-cols-2 gap-2">
                                  {tab === "lista" ? (
                                    <a
                                      href={it.link_compra ?? "#"}
                                      target="_blank"
                                      rel="noreferrer"
                                      className={[
                                        "rounded-lg px-2 py-1.5 text-center text-[11px] sm:text-xs font-semibold",
                                        desabilitar || !it.link_compra
                                          ? "pointer-events-none bg-gray-100 text-gray-400"
                                          : "bg-black text-white hover:opacity-90",
                                      ].join(" ")}
                                    >
                                      Comprar
                                    </a>
                                  ) : (
                                    <div className="rounded-lg bg-gray-100 text-gray-500 text-center text-[11px] sm:text-xs font-semibold px-2 py-1.5">
                                      Pix
                                    </div>
                                  )}

                                  <button
                                    type="button"
                                    className="rounded-lg px-2 py-1.5 text-[11px] sm:text-xs font-semibold bg-blue-600 text-white hover:opacity-90"
                                    onClick={() => setPixItem(it)}
                                  >
                                    Pix
                                  </button>

                                  {tab === "lista" ? (
                                    <button
                                      type="button"
                                      disabled={desabilitar}
                                      className={[
                                        "col-span-2 rounded-lg px-2 py-2 text-[11px] sm:text-xs font-semibold",
                                        desabilitar ? "bg-gray-100 text-gray-400" : "bg-green-600 text-white hover:opacity-90",
                                      ].join(" ")}
                                      onClick={() => setConfirmItem(it)}
                                    >
                                      Já comprei 😊
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="col-span-2 rounded-lg px-2 py-2 text-[11px] sm:text-xs font-semibold bg-green-600 text-white hover:opacity-90"
                                      onClick={() => {
                                        const v = it.preco_sugerido ?? null;
                                        if (v == null || v <= 0) {
                                          alert("Esse Pix precisa ter um valor sugerido no Supabase.");
                                          return;
                                        }
                                        abrirIdentificacao({ kind: "pix_item", item: it, valor: Number(v) });
                                      }}
                                    >
                                      Confirmar Pix 😊
                                    </button>
                                  )}
                                </div>

                                {tab === "pix" && (
                                  <p className="mt-2 text-[11px] text-gray-700">
                                    Este Pix continua disponível para outras pessoas.
                                  </p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* MODAL PIX */}
      {pixItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Pix</h3>
                <p className="text-sm text-gray-700">{pixItem.nome}</p>
              </div>

              <button
                onClick={() => setPixItem(null)}
                className="rounded-lg px-3 py-1 text-sm text-gray-700 hover:bg-gray-100"
              >
                Fechar
              </button>
            </div>

            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm text-gray-700">Valor</p>
              <p className="mt-1 text-xl font-semibold text-gray-900">{formatBRL(pixItem.preco_sugerido)}</p>
            </div>

            <div className="mt-4 flex flex-col items-center">
              <div className="rounded-xl border border-gray-200 bg-white p-3">
                <QRCodeCanvas value={currentEmv(pixItem.preco_sugerido) || "PIX"} size={qrSize} />
              </div>
              <p className="mt-2 text-center text-xs text-gray-700">Se o QR não funcionar, use o “copia e cola”.</p>
            </div>

            <div className="mt-4">
              <p className="text-sm font-semibold text-gray-900">Pix copia e cola</p>

              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  value={currentEmv(pixItem.preco_sugerido) || "Defina NEXT_PUBLIC_PIX_EMV no .env.local"}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900"
                />
                <button
                  onClick={() => copiarTexto(currentEmv(pixItem.preco_sugerido))}
                  disabled={!currentEmv(pixItem.preco_sugerido)}
                  className={[
                    "rounded-xl px-3 py-2 text-sm font-semibold",
                    currentEmv(pixItem.preco_sugerido)
                      ? "bg-black text-white hover:opacity-90"
                      : "bg-gray-100 text-gray-400",
                  ].join(" ")}
                >
                  {copiado ? "Copiado!" : "Copiar"}
                </button>
              </div>

              <p className="mt-2 text-xs text-gray-700">
                Depois de fazer o Pix, clique em <b>Confirmar</b>.
              </p>
            </div>

            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setPixItem(null)}
                className="w-1/2 rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm font-semibold hover:bg-gray-50 text-gray-900"
              >
                Voltar
              </button>

              <button
                onClick={() => {
                  const v = pixItem.preco_sugerido ?? null;
                  if (v == null || v <= 0) {
                    alert("Esse item precisa ter um preço sugerido.");
                    return;
                  }

                  if (pixItem.id === "pix-livre") {
                    abrirIdentificacao({ kind: "pix_livre", valor: Number(v) });
                    setPixItem(null);
                    return;
                  }

                  if ((pixItem.aba ?? "lista") === "pix" || pixItem.repetivel) {
                    abrirIdentificacao({ kind: "pix_item", item: pixItem, valor: Number(v) });
                    setPixItem(null);
                    return;
                  }

                  abrirIdentificacao({ kind: "pix_item", item: pixItem, valor: Number(v) });
                  setPixItem(null);
                }}
                className="w-1/2 rounded-xl bg-green-600 px-3 py-3 text-sm font-semibold text-white hover:opacity-90"
              >
                Confirmar 😊
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL CONFIRMAR COMPRA */}
      {confirmItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Confirmar</h3>
                <p className="text-sm text-gray-700">
                  Você comprou/fez Pix do item <b>{confirmItem.nome}</b>?
                </p>
              </div>

              <button
                onClick={() => setConfirmItem(null)}
                className="rounded-lg px-3 py-1 text-sm text-gray-700 hover:bg-gray-100"
              >
                Fechar
              </button>
            </div>

            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setConfirmItem(null)}
                className="w-1/2 rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm font-semibold hover:bg-gray-50 text-gray-900"
              >
                Cancelar
              </button>

              <button
                disabled={confirmLoading}
                onClick={() => {
                  abrirIdentificacao({ kind: "comprar_item", item: confirmItem });
                  setConfirmItem(null);
                }}
                className={[
                  "w-1/2 rounded-xl px-3 py-3 text-sm font-semibold text-white",
                  confirmLoading ? "bg-green-300" : "bg-green-600 hover:opacity-90",
                ].join(" ")}
              >
                {confirmLoading ? "..." : "Sim 😊"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL IDENTIFICAÇÃO */}
      {identifyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Deseja se identificar?</h3>
            <p className="mt-1 text-sm text-gray-700">Se você colocar seu nome, ele aparece no item comprado.</p>

            <div className="mt-4">
              <label className="text-xs font-semibold text-gray-900">Seu nome (opcional)</label>
              <input
                value={identifyNome}
                onChange={(e) => setIdentifyNome(e.target.value)}
                placeholder="Ex: Ana"
                className="mt-2 w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm outline-none focus:border-gray-400 text-gray-900 placeholder:text-gray-500"
              />
            </div>

            <div className="mt-5 flex gap-2">
              <button
                disabled={identifySaving}
                onClick={() => finalizarComNomeOuNao(null)}
                className="w-1/2 rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm font-semibold hover:bg-gray-50 text-gray-900 disabled:opacity-60"
              >
                Não
              </button>

              <button
                disabled={identifySaving}
                onClick={() => {
                  const nome = identifyNome.trim();
                  finalizarComNomeOuNao(nome ? nome : null);
                }}
                className="w-1/2 rounded-xl bg-black px-3 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
              >
                Sim
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}