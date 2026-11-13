# Local semantic media search: implementation notes

This feature is not implemented yet. It should complement local title suggestions and normal TMDB search. In particular, a plot search must work when the user does not know the title.

## Documents and model

Build documents from TMDB's localized overview, human-readable genre names, original language, and titles. Treat an empty overview as missing descriptive data, not an informative synopsis. Titles help disambiguate but should not dominate the embedding. Embed each query with `query: ` and each document with `passage: `, as required by [multilingual E5](https://huggingface.co/intfloat/multilingual-e5-small). Keep the lexical and semantic result sections separate so a semantic match does not displace an exact title match.

The leading candidate is the MIT-licensed multilingual E5 small model, with the [Xenova ONNX conversion](https://huggingface.co/Xenova/multilingual-e5-small) at revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`. Download the pinned quantized model and tokenizer only after the administrator enables the feature; validate their hashes. The quantized model file is 118,308,185 bytes and tokenizer.json is 17,082,730 bytes. Version the index with the model, document format and language so changes are rebuilt correctly.

A disposable test used 871 Tamil and Malayalam movies, including 817 with overviews, and six English, Tamil and Malayalam queries. The intended result ranked 1, 1, 1, 2, 1 and 3 with int8 model weights, compared with 1, 1, 1, 2, 1 and 2 with float32. On the development Mac, the quantized batch took 5.9 seconds compared with 11.6 seconds for float32. This is a small, targeted sample, not a general accuracy or speed guarantee. A separate WebAssembly runtime prototype retrieved all six expected titles from an eight-film corpus. More diverse and held-out evaluation is needed, particularly for cross-language plots and uncommon titles.

Model weight quantization and stored-vector quantization are different decisions. Measure int8 vector retrieval and approximate nearest-neighbor recall against a float32 exact baseline before choosing either. Do not assume E5 supports Matryoshka truncation.

## Ingest and operations

TMDB's [daily exports](https://developer.themoviedb.org/docs/daily-id-exports) contain IDs and limited attributes, not overviews. A full initial ingest thus requires paginated Discover queries or individual detail requests. Discover has a page limit; partition by date and, if necessary, language or smaller intervals. Prioritize popular and locally requested media, checkpoint progress, cap concurrency, back off on rate limits, and run model inference away from the HTTP event loop. Expose progress, resource use and errors; preserve the usable index on interruption.

After bootstrap, use TMDB's [change lists](https://developer.themoviedb.org/docs/tracking-content-changes) and re-embed only when indexed text changes. Changes are available for at most 14 days per query, so checkpoint reliably and define a reconciliation path after longer outages. Remove records no longer present in the daily export. Incremental operation still requires network and compute; neither TMDB nor IMDb provides an embedding-ready catalogue.

A WebAssembly ONNX runtime and a local JavaScript tokenizer worked on the development Mac. Before shipping, verify the complete production bundle, startup, memory consumption and model inference on Seerr's Alpine/musl Docker image and supported CPU architectures. Do not silently add a native-only dependency or require an external inference service.
