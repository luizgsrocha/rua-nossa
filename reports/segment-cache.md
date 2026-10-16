# Cache por trecho — linha de base e comparação

**Medição final:** 16/10/2026, 16:59 UTC · **Node.js:** v24.19.0 · **Repetições:** 30 por cenário.

## Método

O benchmark `scripts/benchmark-segment-cache.mjs` executa o Worker e o seletor RN-HUB reais contra uma fonte local determinística. Alterna Taubaté → Uberlândia e São Paulo → Uberlândia, com os mesmos horários simulados, uma perna compartilhada e um par de cidades que responde 503. Cada consulta externa simulada demora 18 ms. Nenhuma chamada foi feita ao BuscaÔnibus ou à BlaBlaCar.

- **Linha de base:** 30 buscas sem o binding `RIDES_CACHE`; o Worker percorre seu caminho de fallback e não faz leituras ou gravações KV.
- **Cache frio:** cache ativado e esvaziado antes de cada busca.
- **Cache aquecido:** mesma instância KV simulada entre buscas alternadas.
- Latência é o tempo total do Worker no processo Node; P50/P95 usam nearest-rank empírico.
- “Consultas externas” conta invocações de `fetch` do Worker na fonte simulada. Não é contagem de requisições que alcançariam a origem do provedor após o cache HTTP da Cloudflare.
- Erros contam respostas 503 do trecho indisponível. Busca incompleta é o sinal retornado pela busca inteira.

## Resultados medidos

| Cenário | Tempo médio | P50 | P95 | Chamadas à fonte | Chamadas/busca | Erros de trecho | Buscas incompletas | Rotas encontradas |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Linha de base | 449,502 ms | 477,915 ms | 507,685 ms | 990 | 33,0 | 15 | 0/30 | 15 |
| Cache frio | 470,533 ms | 477,848 ms | 670,825 ms | 990 | 33,0 | 15 | 0/30 | 15 |
| Cache aquecido | 70,561 ms | 49,089 ms | 344,936 ms | 93 | 3,1 | 15 | 0/30 | 15 |

No cenário aquecido foram evitadas **897 de 990 invocações** comparadas à linha de base (**90,6%**). A latência P50 medida caiu **89,7%**, a P95 caiu **32,1%** e a média caiu **84,3%**. A cauda continua alta porque buscas ainda consultam trechos ausentes do cache e obedecem ao orçamento/tempo atuais, que não foram alterados. A P95 do cenário frio variou para cima nesta execução local, embora a P50 ficasse praticamente igual à linha de base; isso reforça que a comparação de latência é específica deste ensaio.

Em uma sequência separada de quatro buscas alternadas, foram medidas 42 chamadas contra 132 sem reaproveitamento, ou **90 chamadas evitadas**. O cache frio não evitou chamadas, como esperado.

## Falhas e integridade

O par `taubate|uberaba` falha de forma determinística. O erro não é armazenado: foram contados 15 erros em cada cenário normal, correspondendo às mesmas buscas Taubaté → Uberlândia; as rotas restantes foram confirmadas e o total de rotas foi 15 em todos os cenários. Uma simulação de indisponibilidade total produziu 18 respostas de erro, zero rotas e `incomplete=true`.

As respostas vazias bem-sucedidas podem ser armazenadas por até 180 segundos. Falhas HTTP, timeouts e erros de leitura não são gravados. A chave separa versão do cache, data, sentido e slugs usados pelo provedor.

## Limites do ensaio

O KV foi representado pelo mesmo contrato `get/put` com TTL em memória. **Não foi possível medir latência, consistência ou disponibilidade do namespace KV real**, porque o teste não foi implantado com binding remoto. O `wrangler deploy --dry-run` validou que a configuração declara `RIDES_CACHE`, mas não publica nem provisiona o namespace. Os resultados de latência são deste ambiente local e não representam latência de produção.

Reproduza com:

```sh
node scripts/benchmark-segment-cache.mjs
```
