"""Ciclo de atualização: coleta → eventos → publicação.

    python -m motor.atualizar            # um ciclo completo
    python -m motor.atualizar --rapido   # só tempo real (10 min) + republicação
"""
import sys
import time
import traceback

from . import clima, ingest, eventos, lixoes, publicar, precalcular


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
    try:   # alertas de tempo real primeiro: são os que importam agora
        print("clima de eventos:", clima.enriquecer(alertas + evs))
    except Exception:
        traceback.print_exc()
    try:
        clima.grade_vento()
    except Exception:
        traceback.print_exc()
    eventos.aplicar_clima(evs + alertas)
    try:
        print("eventos perto de lixão:", lixoes.marcar(evs + alertas, lixoes.atualizar()))
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
    ingest.salvar_status(ultimo_ciclo=est["gerado_em"], duracao_ciclo_s=round(time.time() - t0, 1))
    print(f"ok: {len(evs)} eventos, {len(alertas)} alertas em tempo real, {time.time() - t0:.0f}s")
    return est


if __name__ == "__main__":
    ciclo(rapido="--rapido" in sys.argv)
