"""Ciclo de atualização: coleta → eventos → publicação.

    python -m motor.atualizar            # um ciclo completo
    python -m motor.atualizar --rapido   # só tempo real (10 min) + republicação
"""
import sys
import time
import traceback

from . import (ar, biodiversidade, clima, contexto, erbs, estradas, goes, ingest, eventos, lixoes, mudanca, publicar,
               precalcular, riscoprev, territorio)


def ciclo(rapido=False):
    t0 = time.time()
    if not rapido:
        ingest.areas()
        ingest.historico_ref()
        ingest.inicializar_ano_corrente()
        for etapa in (ingest.atualizar_deter, ingest.atualizar_diario):
            try:
                print(etapa.__name__, etapa())
            except Exception:
                traceback.print_exc()
    try:
        print("atualizar_10min", ingest.atualizar_10min())
    except Exception:
        traceback.print_exc()
    df, evs, alertas = eventos.calcular()
    # consultas externas novas: orçamento cheio no ciclo completo, mínimo nos rápidos (o cache é sempre aplicado)
    territorio.MAX_SEGUNDOS = 15 if rapido else 90
    biodiversidade.TEMPO_S = 10 if rapido else 60
    contexto.PRODES_TEMPO_S = 10 if rapido else 60
    ar.MAX_NOVOS = 50 if rapido else 300
    try:   # alertas de tempo real primeiro: são os que importam agora
        print("clima de eventos:", clima.enriquecer(alertas + evs))
    except Exception:
        traceback.print_exc()
    try:
        clima.grade_vento()
    except Exception:
        traceback.print_exc()
    eventos.aplicar_clima(evs + alertas)
    try:   # hora da 1ª detecção geoestacionária (GOES), já presente nos focos do INPE
        print("eventos com detecção GOES:", goes.marcar(evs + alertas, df))
    except Exception:
        traceback.print_exc()
    try:   # uso da terra, histórico de fogo (MapBiomas) e relevo (Copernicus DEM)
        print("território:", territorio.enriquecer(alertas + evs))
        territorio.aplicar(evs + alertas)
    except Exception:
        traceback.print_exc()
    for nome, f in (("estradas (OSM)", lambda: estradas.marcar(evs + alertas, estradas.atualizar())),
                    ("fundiário, água e infraestrutura", lambda: contexto.marcar(evs + alertas)),
                    ("floresta pública (prioridade)", lambda: len(contexto.aplicar(evs + alertas))),
                    ("PRODES", lambda: contexto.prodes(alertas + evs)),
                    ("biodiversidade (GBIF)", lambda: biodiversidade.enriquecer(alertas + evs)),
                    ("risco previsto (INPE)", lambda: len(riscoprev.atualizar().get("dias", [])))):
        try:
            print(nome + ":", f())
        except Exception:
            traceback.print_exc()
    eventos.atipicidade(evs, alertas)   # depois do território, que entra no modelo
    try:   # fumaça (CAMS): PM2,5 no local e em Manaus
        print("qualidade do ar:", ar.enriquecer(alertas + evs))
    except Exception:
        traceback.print_exc()
    try:
        print("eventos perto de lixão:", lixoes.marcar(evs + alertas, lixoes.atualizar()))
    except Exception:
        traceback.print_exc()
    try:
        print("eventos com ERB a até 15 km:", erbs.marcar(evs + alertas, erbs.atualizar()))
    except Exception:
        traceback.print_exc()
    evs.sort(key=lambda e: (-e["score"], -e["n_focos"]))
    alertas.sort(key=lambda e: (-e["score"], -e["n_focos"]))
    est = publicar.publicar(df, evs, alertas)
    if "--sem-ndvi" not in sys.argv:
        try:
            precalcular.ciclo(evs)
            est = publicar.atualizar_indice_analises(evs)   # inclui as análises e pareceres deste ciclo
        except Exception:
            traceback.print_exc()
        try:
            print("alertas de mudança:", mudanca.ciclo(evs + alertas))
        except Exception:
            traceback.print_exc()
    ingest.salvar_status(ultimo_ciclo=est["gerado_em"], duracao_ciclo_s=round(time.time() - t0, 1))
    print(f"ok: {len(evs)} eventos, {len(alertas)} alertas em tempo real, {time.time() - t0:.0f}s")
    return est


if __name__ == "__main__":
    ciclo(rapido="--rapido" in sys.argv)
