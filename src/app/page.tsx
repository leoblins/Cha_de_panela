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

  // NOVOS
  comprador_nome?: string | null;
  repetivel?: boolean;
  aba?: "lista" | "pix" | string;
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

type TabKey = "lista" | "pix";

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

  // Para Pix valor livre
  const [pixValorLivre, setPixValorLivre] = useState<string>("");

  // Fluxo "comprar/pix" -> identificar
  const [confirmItem, setConfirmItem] = useState<ItemCha | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const [identifyOpen, setIdentifyOpen] = useState(false);
  const [identifyNome, setIdentifyNome] = useState("");
  const [identifySkipping, setIdentifySkipping] = useState(false);

  // Contexto: o que vamos registrar quando confirmar?
  const [pendingAction, setPendingAction] = useState<
    | { kind: "comprar_item"; item: ItemCha }
    | { kind: "pix_item"; item: ItemCha; valor: number }
    | { kind: "pix_livre"; valor: number }
    | null
  >(null);

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

    // abre categorias na primeira carga (só da aba atual)
    setCategoriasAbertas((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<string, boolean> = {};
      for (const it of rows.filter((r) => (r.aba ?? "lista") === "lista")) next[it.categoria] = true;
      return next;
    });

    setLoading(false);
  }

  useEffect(() => {
    carregar();
  }, []);

  // Filtra itens pela aba
  const itensDaAba = useMemo(() => {
    return itens.filter((it) => ((it.aba ?? "lista") as TabKey) === tab);
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

    // Ordenação: itens comprados vão pro fim, EXCETO repetíveis (pix) — que nunca “some”
    for (const [cat, arr] of map.entries()) {
      arr.sort((a, b) => {
        const aRep = !!a.repetivel;
        const bRep = !!b.repetivel;

        // repetíveis primeiro (pra Pix ficar sempre “disponível”)
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

  // ====== Ações ======

  // 1) Itens normais: marcar como comprado (e opcionalmente salvar nome)
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

  // 2) Pix (repetível ou não): registrar contribuição
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

  // Fecha todos modais de fluxo
  function resetIdentifyFlow() {
    setIdentifyOpen(false);
    setIdentifyNome("");
    setIdentifySkipping(false);
    setPendingAction(null);
  }

  // Abre modal de identificação (Sim/Não)
  function abrirIdentificacao(action: NonNullable<typeof pendingAction>) {
    setPendingAction(action);
    setIdentifyOpen(true);
    setIdentifyNome("");
    setIdentifySkipping(false);
  }

  // Confirmar (Sim) do modal “Você comprou?”
  function confirmarAcaoPrincipal(item: ItemCha) {
    // Se for repetível, não marca comprado: vai só registrar Pix (normalmente)
    // Mas aqui “Já comprei” é para itens da LISTA (não repetíveis).
    abrirIdentificacao({ kind: "comprar_item", item });
  }

  // Confirmar “Já fiz o Pix” no modal Pix
  function confirmarPixDoItem(item: ItemCha, valor: number) {
    abrirIdentificacao({ kind: "pix_item", item, valor });
  }

  // Confirmar Pix valor livre
  function confirmarPixLivre(valor: number) {
    abrirIdentificacao({ kind: "pix_livre", valor });
  }

  async function finalizarComNomeOuNao(nome: string | null) {
    if (!pendingAction) return;

    // trava botões do modal
    setIdentifySkipping(true);

    try {
      if (pendingAction.kind === "comprar_item") {
        await efetivarCompraItem(pendingAction.item, nome);
      }

      if (pendingAction.kind === "pix_item") {
        // sempre registra contribuição
        await registrarPix(pendingAction.item.id, pendingAction.valor, nome);

        // se NÃO for repetível, podemos marcar como comprado também (opcional)
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
      setIdentifySkipping(false);
    }
  }

  // ===== UI: responsivo =====
  // grid já estava bom, mas melhoramos pro mobile:
  // - 1 coluna em telas bem pequenas
  // - QR menor em telas pequenas

  return (
    <main className="relative min-h-screen">
      {/* FUNDO com blur */}
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

        {/* TABS */}
        <div className="mx-auto mb-4 sm:mb-6 max-w-3xl">
          <div className="grid grid-cols-2 rounded-2xl bg-white/80 p-1 shadow backdrop-blur">
            <button
              onClick={() => setTab("lista")}
              className={[
                "rounded-xl py-2 text-sm font-semibold",
                tab === "lista" ? "bg-black text-white" : "text-gray-700 hover:bg-white/70",
              ].join(" ")}
            >
              Lista de itens
            </button>
            <button
              onClick={() => setTab("pix")}
              className={[
                "rounded-xl py-2 text-sm font-semibold",
                tab === "pix" ? "bg-black text-white" : "text-gray-700 hover:bg-white/70",
              ].join(" ")}
            >
              Para não dizer que não dei nada
            </button>
          </div>
        </div>

        {/* BUSCA (só faz sentido na lista, mas pode deixar nas duas) */}
        <div className="mx-auto mb-6 sm:mb-8 max-w-3xl">
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={tab === "pix" ? "Buscar (Pix)..." : "Buscar item..."}
            className="w-full rounded-xl bg-white/90 px-4 py-3 text-sm shadow outline-none focus:ring-2 focus:ring-white/50"
          />
        </div>

        {loading && <p className="text-sm text-white/90">Carregando...</p>}
        {erro && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">Erro: {erro}</div>
        )}

        {/* A BAIXO: Aba PIX ainda tem o card “valor livre” (não precisa estar no banco) */}
        {tab === "pix" && (
          <section className="mb-6 rounded-2xl bg-white/90 shadow-lg backdrop-blur">
            <div className="px-5 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold">Pix de valor livre</h2>
              <p className="text-xs text-gray-600 mt-1">
                Escolha qualquer valor.
              </p>
            </div>

            <div className="p-5">
              <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
                <input
                  value={pixValorLivre}
                  onChange={(e) => setPixValorLivre(e.target.value)}
                  inputMode="decimal"
                  placeholder="Ex: 50.00"
                  className="w-full sm:w-56 rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm outline-none focus:border-gray-400"
                />
                <button
                  onClick={() => {
                    const n = Number(String(pixValorLivre).replace(",", "."));
                    if (!isFinite(n) || n <= 0) {
                      alert("Digite um valor válido. Ex: 35.00");
                      return;
                    }
                    // abre modal pix com “item fake” só pra mostrar QR
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
             
            </div>
          </section>
        )}

        {/* CATEGORIAS */}
        <div className="space-y-6">
          {[...porCategoria.entries()].map(([cat, lista]) => {
            const aberta = categoriasAbertas[cat] ?? true;

            // na aba pix você pode preferir sempre aberto:
            const isPixTab = tab === "pix";
            const abertaFinal = isPixTab ? true : aberta;

            return (
              <section key={cat} className="rounded-2xl bg-white/90 shadow-lg backdrop-blur">
                {/* Header + botão minimizar (na aba pix deixo sem botão) */}
                <div className="flex w-full items-center justify-between px-5 py-4">
                  <div className="text-left">
                    <h2 className="text-lg font-semibold">
                      {cat} ({lista.length})
                    </h2>
                  </div>

                  {!isPixTab && (
                    <button
                      onClick={() => toggleCategoria(cat)}
                      className="text-xl font-bold text-gray-700 w-10 h-10 rounded-xl hover:bg-black/5"
                      aria-label="Abrir/fechar categoria"
                    >
                      {aberta ? "−" : "+"}
                    </button>
                  )}
                </div>

                {abertaFinal && (
                  <div className="px-4 sm:px-5 pb-5">
                    {/* 1 coluna em mobile bem pequeno */}
                    <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                      {lista.map((it) => {
                        const repetivel = !!it.repetivel;
                        const comprado = it.status === "comprado";

                        // regra: na aba pix (repetível) nunca apaga
                        const desabilitar = tab === "pix" ? false : comprado;

                        return (
                          <div
                            key={it.id}
                            className={[
                              "overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm",
                              // só deixa cinza quando não é repetível
                              !repetivel && comprado ? "opacity-60" : "opacity-100",
                            ].join(" ")}
                          >
                            {/* IMAGEM quadrada */}
                            <div className="aspect-square w-full bg-gray-100">
                              {it.imagem_url ? (
                                <img src={it.imagem_url} alt={it.nome} className="h-full w-full object-cover" />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center text-xs text-gray-500">
                                  Sem imagem
                                </div>
                              )}
                            </div>

                            <div className="p-3">
                              <div className="min-h-[40px]">
                                <p className="text-sm font-semibold leading-snug">{it.nome}</p>
                              </div>

                              <div className="mt-2 flex items-center justify-between">
                                <p className="text-sm font-medium">{formatBRL(it.preco_sugerido)}</p>

                                {/* status + (se comprado e tiver nome) mostra nome */}
                                {repetivel ? (
                                  <p className="text-xs font-medium text-gray-600">✨ Pix</p>
                                ) : (
                                  <div className="text-right">
                                    <p className="text-xs font-medium text-gray-600">
                                      {comprado ? "😊 Comprado" : "😢 Não comprado"}
                                    </p>
                                    {comprado && it.comprador_nome ? (
                                      <p className="text-[11px] text-gray-500">por {it.comprador_nome}</p>
                                    ) : null}
                                  </div>
                                )}
                              </div>

                              {/* BOTÕES */}
                              <div className="mt-3 grid grid-cols-2 gap-2">
                                {/* Comprar só faz sentido na lista normal */}
                                {tab === "lista" ? (
                                  <a
                                    href={it.link_compra ?? "#"}
                                    target="_blank"
                                    rel="noreferrer"
                                    className={[
                                      "rounded-lg px-2 py-2 text-center text-xs font-medium",
                                      desabilitar || !it.link_compra
                                        ? "pointer-events-none bg-gray-100 text-gray-400"
                                        : "bg-black text-white hover:opacity-90",
                                    ].join(" ")}
                                  >
                                    Comprar
                                  </a>
                                ) : (
                                  <div className="rounded-lg bg-gray-100 text-gray-400 text-center text-xs font-medium px-2 py-2">
                                    Pix
                                  </div>
                                )}

                                <button
                                  type="button"
                                  disabled={false}
                                  className="rounded-lg px-2 py-2 text-xs font-medium bg-blue-600 text-white hover:opacity-90"
                                  onClick={() => setPixItem(it)}
                                >
                                  Pix
                                </button>

                                {/* Já comprei: na aba pix vira “Confirmar Pix” */}
                                {tab === "lista" ? (
                                  <button
                                    type="button"
                                    disabled={desabilitar}
                                    className={[
                                      "col-span-2 rounded-lg px-2 py-2 text-xs font-semibold",
                                      desabilitar ? "bg-gray-100 text-gray-400" : "bg-green-600 text-white hover:opacity-90",
                                    ].join(" ")}
                                    onClick={() => setConfirmItem(it)}
                                  >
                                    Já comprei 😊
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="col-span-2 rounded-lg px-2 py-2 text-xs font-semibold bg-green-600 text-white hover:opacity-90"
                                    onClick={() => {
                                      const v = it.preco_sugerido ?? null;
                                      if (v == null || v <= 0) {
                                        alert("Esse Pix precisa ter um valor sugerido no Supabase.");
                                        return;
                                      }
                                      confirmarPixDoItem(it, Number(v));
                                    }}
                                  >
                                    Confirmar Pix 😊
                                  </button>
                                )}
                              </div>

                              {/* Dica no Pix */}
                              {tab === "pix" && (
                                <p className="mt-2 text-[11px] text-gray-500">
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
      </div>

      {/* MODAL PIX */}
      {pixItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Pix</h3>
                <p className="text-sm text-gray-600">{pixItem.nome}</p>
              </div>

              <button
                onClick={() => setPixItem(null)}
                className="rounded-lg px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
              >
                Fechar
              </button>
            </div>

            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm text-gray-700">Valor</p>
              <p className="mt-1 text-xl font-semibold">{formatBRL(pixItem.preco_sugerido)}</p>
            </div>

            <div className="mt-4 flex flex-col items-center">
              <div className="rounded-xl border border-gray-200 bg-white p-3">
                <QRCodeCanvas
                  value={currentEmv(pixItem.preco_sugerido) || "PIX"}
                  size={window.innerWidth < 420 ? 180 : 220}
                />
              </div>
              <p className="mt-2 text-center text-xs text-gray-500">
                Se o QR não funcionar, use o “copia e cola”.
              </p>
            </div>

            <div className="mt-4">
              <p className="text-sm font-medium text-gray-700">Pix copia e cola</p>

              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  value={currentEmv(pixItem.preco_sugerido) || "Defina NEXT_PUBLIC_PIX_EMV no .env.local"}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm"
                />
                <button
                  onClick={() => copiarTexto(currentEmv(pixItem.preco_sugerido))}
                  disabled={!currentEmv(pixItem.preco_sugerido)}
                  className={[
                    "rounded-xl px-3 py-2 text-sm font-semibold",
                    currentEmv(pixItem.preco_sugerido) ? "bg-black text-white hover:opacity-90" : "bg-gray-100 text-gray-400",
                  ].join(" ")}
                >
                  {copiado ? "Copiado!" : "Copiar"}
                </button>
              </div>

              <p className="mt-2 text-xs text-gray-500">
                Depois de fazer o Pix, clique em <b>Confirmar</b>.
              </p>
            </div>

            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setPixItem(null)}
                className="w-1/2 rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm font-semibold hover:bg-gray-50"
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

                  // Se for o “pix-livre” (card especial), registra como pix livre
                  if (pixItem.id === "pix-livre") {
                    confirmarPixLivre(Number(v));
                    setPixItem(null);
                    return;
                  }

                  // Se estiver na aba pix (repetível), registra contribuição sem marcar comprado
                  if ((pixItem.aba ?? "lista") === "pix" || pixItem.repetivel) {
                    confirmarPixDoItem(pixItem, Number(v));
                    setPixItem(null);
                    return;
                  }

                  // Senão é item normal: fluxo pix que marca comprado
                  confirmarPixDoItem(pixItem, Number(v));
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

      {/* MODAL CONFIRMAR COMPRA (Sim/Cancelar) — somente lista normal */}
      {confirmItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Confirmar</h3>
                <p className="text-sm text-gray-600">
                  Você comprou/fez Pix do item <b>{confirmItem.nome}</b>?
                </p>
              </div>

              <button
                onClick={() => setConfirmItem(null)}
                className="rounded-lg px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
              >
                Fechar
              </button>
            </div>

            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setConfirmItem(null)}
                className="w-1/2 rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm font-semibold hover:bg-gray-50"
              >
                Cancelar
              </button>

              <button
                disabled={confirmLoading}
                onClick={() => {
                  // abre identificação
                  confirmarAcaoPrincipal(confirmItem);
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
            <h3 className="text-lg font-semibold">Deseja se identificar?</h3>
            <p className="mt-1 text-sm text-gray-600">
              Se você colocar seu nome, ele vai aparecer no item (quando for um item comprado).
            </p>

            <div className="mt-4">
              <label className="text-xs font-medium text-gray-700">Seu nome (opcional)</label>
              <input
                value={identifyNome}
                onChange={(e) => setIdentifyNome(e.target.value)}
                placeholder="Ex: Bianca"
                className="mt-2 w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm outline-none focus:border-gray-400"
              />
            </div>

            <div className="mt-5 flex gap-2">
              <button
                disabled={identifySkipping}
                onClick={() => finalizarComNomeOuNao(null)}
                className="w-1/2 rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm font-semibold hover:bg-gray-50 disabled:opacity-60"
              >
                Não
              </button>

              <button
                disabled={identifySkipping}
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