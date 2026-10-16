# RN-HUB — Índice Nacional de Relevância de Conexões

## Estado e ativação

O RN-HUB é experimental e fica **desligado em produção por padrão**. O preview de branches define `RN_HUB_ENABLED=1` em `[previews.vars]`, enquanto a configuração principal não define a variável. Assim a produção continua usando RN-DIR, RN-CUR, RN-LON e RN-ROT sem mudanças.

Para validar em outro ambiente isolado, configure `RN_HUB_ENABLED=1`. Se o índice estiver ausente, inválido ou incompatível, o Worker volta automaticamente ao seletor geográfico atual. Para rollback, remova a variável ou defina-a como `0`; não é necessário remover código nem dados.

RN-DIR permanece independente. RN-CUR e RN-LON continuam classificando a distância e são o fallback. RN-ROT conserva o grafo limitado, os filtros temporais e o limite de 55 consultas; o RN-HUB apenas fornece candidatos e priorização adicionais.

## Auditoria do mecanismo anterior

| Componente | Comportamento preservado | Limitação observada |
|---|---|---|
| RN-DIR | Consulta direta e independente | Depende da disponibilidade da fonte |
| RN-CUR | Até 10 hubs; desvio de até 60 km | Lista fixa concentrada no Sudeste/Sul e geometria em linha reta |
| RN-LON | Até 6 hubs distribuídos; desvio adaptativo limitado a 90 km | Pode escolher somente municípios exatamente alinhados e perder polos regionais |
| RN-ROT | Beam 12, até 55 consultas, 80 resultados e 5 minutos | Orçamento dividido por profundidade; falhas da fonte reduzem a cobertura |

O motor já validava cada trecho, espera mínima/máxima, chegada após a partida, repetição de cidades e quantidade máxima de baldeações. Essas regras não foram substituídas. A coordenada serve somente como heurística: não representa distância rodoviária.

## Índice nacional pré-calculado

`rn-hub-index.json` contém um registro compacto para os 5.571 municípios da base. O Worker não consulta o IBGE em tempo de execução. O gerador reproduzível está em `scripts/build-rn-hub-index.py`.

Fontes oficiais:

- IBGE, Estimativas da População 2025, arquivo atualizado em 28/08/2026;
- IBGE, Regiões de Influência das Cidades (REGIC 2018), hierarquia urbana;
- IBGE, REGIC 2018, tabela de ligações entre cidades/arranjos populacionais.

Cobertura gerada: população para 5.559/5.571 e REGIC para 5.564/5.571 registros. Ausências recebem zero no componente indisponível, sem eliminar o município. Ligações REGIC funcionam como indicador de conectividade e acesso a um arranjo urbano; esta versão não afirma conhecer terminais, linhas ou infraestrutura física municipal em tempo real.

O escore nacional, de 0 a 1.000, combina:

`0,38 × hierarquia + 0,32 × log(conectividade) + 0,30 × log(população)`

População não domina o cálculo. Municípios pequenos ligados a centros regionais mantêm chance real de seleção.

## Índice contextual e diversidade

Para cada origem/destino, candidatos dentro de um desvio adaptativo (mínimo 60 km, máximo 250 km ou 30% da distância direta) recebem:

`0,50 × aderência à rota + 0,18 × posição + 0,22 × índice nacional + 0,10 × conector pequeno`

O corredor é dividido em quatro partes. Cada parte reserva espaço para um candidato contextual e um polo nacional, aplica separação geográfica de 35 km e só então preenche as vagas restantes. São usados no máximo 12 candidatos. Isso evita que uma região metropolitana ou apenas capitais consumam todo o orçamento.

## Descoberta e confirmação

Com a flag ativa, até seis consultas partem dos hubs mais próximos do destino para trás. Os resultados entram no mesmo cache da busca para priorizar ramos com um último trecho real. O beam avança da origem e pode montar múltiplas etapas, sempre limitado a `maxTransfers + 1` trechos.

Uma conexão só é retornada quando todos os trechos têm oferta extraída da fonte e os horários respeitam a janela escolhida. Cidades candidatas sem oferta nunca aparecem como carona. `RIDES_CACHE` armazena respostas extraídas por trecho, sentido, data e versão do formato por 180 segundos. Respostas vazias bem-sucedidas também são reutilizadas; falhas e timeouts não são gravados. O cache local da busca continua evitando chamadas duplicadas dentro da mesma requisição. Se o binding KV estiver ausente ou indisponível, o Worker segue consultando a fonte e preserva o comportamento anterior.

O namespace KV é declarado em `wrangler.toml` sem ID explícito para usar o provisionamento de recurso do Wrangler no deploy. O teste `--dry-run` valida o binding, mas não cria ou altera recursos na conta. As buscas em produção só usarão o cache quando o Worker for implantado com esse binding.

### Cache por trecho — benchmark reproduzível

Execute a comparação de cache frio e aquecido com a fonte simulada:

```sh
node scripts/benchmark-segment-cache.mjs
```

O script alterna Taubaté → Uberlândia e São Paulo → Uberlândia, mede latência do Worker, quantidade real de fetches externos, respostas de erro e buscas incompletas. A fonte simulada adiciona 18 ms por chamada; nenhum provedor ao vivo é consultado. Os resultados medidos deste PR estão em [reports/segment-cache.md](reports/segment-cache.md). Cache KV simulado verifica a lógica, mas não estima latência de leitura do KV distribuído nem substitui teste após binding em ambiente implantado.

A espera máxima padrão é 720 minutos, ainda editável nas opções avançadas. O padrão anterior de 90 minutos ocultava conexões nacionais reais — por exemplo, Taubaté → Guarulhos → Uberlândia — antes que o passageiro percebesse que o filtro era a causa. Qualquer valor menor escolhido manualmente continua sendo respeitado rigorosamente.

## Benchmark reproduzível

Execute:

```sh
node scripts/benchmark-rn-hub.mjs
```

Medição de referência em Node.js 24, 5.571 municípios, 100 rodadas por corredor:

| Métrica | Seletor atual | RN-HUB |
|---|---:|---:|
| p50 do seletor | 15,4 ms | 17,3 ms |
| p95 do seletor | 17,1 ms | 21,1 ms |
| polos esperados nas 5 rotas | 2/5 | 5/5 |

O arquivo JSON mede 198.734 bytes e sua serialização V8, usada como aproximação reproduzível de memória, mede 187.069 bytes. A busca controlada Taubaté → Ribeirão Preto → Uberaba → Uberlândia confirmou todos os três trechos com 24 consultas, abaixo do teto de 55, e seis sondagens do destino. Tempos são locais e variam por máquina; o script valida orçamento e ganho de cobertura, não impõe um limite frágil de milissegundos.

## Limitações e validação antes de produção

- REGIC 2018 descreve relações urbanas, não disponibilidade atual de caronas.
- Distância geodésica pode divergir da malha rodoviária, balsas e fronteiras naturais.
- A fonte externa pode falhar, bloquear ou omitir ofertas; a resposta sinaliza busca incompleta.
- Slugs municipais repetidos entre estados já existem no contrato atual da API. O índice distingue por UF, mas, como a fonte não aceita UF no identificador, o seletor mantém no máximo um candidato por slug para impedir cache ou confirmação no município homônimo errado.
- Os testes são determinísticos com fonte simulada. Antes de ativar produção, validar em preview, observar CPU, memória, taxa de falhas, consultas por busca e qualidade real, e revisar manualmente uma amostra nacional.
