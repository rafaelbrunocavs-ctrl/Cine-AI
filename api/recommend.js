// CineAI Hybrid Engine v2
// LLM runs once (profile) → TMDB does all discovery → LLM explains briefly

import { kv } from '@vercel/kv';

const TMDB = 'https://api.themoviedb.org/3';
const IMG  = 'https://image.tmdb.org/t/p/';

const GENRE_MAP = {
  'action':28,'adventure':12,'animation':16,'comedy':35,'crime':80,
  'documentary':99,'drama':18,'family':10751,'fantasy':14,'history':36,
  'horror':27,'music':10402,'mystery':9648,'romance':10749,
  'science fiction':878,'sci-fi':878,'thriller':53,'war':10752,'western':37,
  'ação':28,'aventura':12,'comédia':35,'drama':18,'fantasia':14,
  'história':36,'terror':27,'mistério':9648,'ficção científica':878,'guerra':10752,
};

function genreIds(names=[]) {
  return [...new Set((names||[]).map(n=>GENRE_MAP[n?.toLowerCase()]).filter(Boolean))];
}

function hashStr(s) {
  let h=0; for(let i=0;i<s.length;i++) h=(Math.imul(31,h)+s.charCodeAt(i))|0;
  return Math.abs(h).toString(36);
}

async function gemini(system, prompt, maxTokens=400) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        contents:[
          {role:'user',  parts:[{text:system+'\n\n---'}]},
          {role:'model', parts:[{text:'Entendido.'}]},
          {role:'user',  parts:[{text:prompt}]},
        ],
        generationConfig:{maxOutputTokens:maxTokens, temperature:0.5}
      })
    }
  );
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message||'Gemini error');
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function parseJSON(raw) {
  try { return JSON.parse(raw.replace(/```json|```/g,'').trim()); } catch { return null; }
}

async function tmdbFetch(path, params={}) {
  const u = new URL(TMDB+path);
  u.searchParams.set('api_key', process.env.TMDB_API_KEY);
  u.searchParams.set('language','pt-BR');
  Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error(`TMDB ${r.status} ${path}`);
  return r.json();
}

async function cacheGet(key) { try { return await kv.get(key); } catch { return null; } }
async function cacheSet(key, val, ex) { try { await kv.set(key,val,{ex}); } catch {} }

function scoreMovie(m, profileGenreIds=[]) {
  const vote    = (m.vote_average||0)/10;
  const pop     = Math.min((m.popularity||0)/500,1);
  const year    = parseInt(m.release_date?.slice(0,4))||2000;
  const recency = Math.max(0,(year-1970)/55);
  const match   = m.genre_ids?.some(id=>profileGenreIds.includes(id)) ? 1 : 0;
  return vote*0.4 + pop*0.2 + match*0.3 + recency*0.1;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST')    return res.status(405).json({error:'Method not allowed'});

  const body = req.body||{};
  const {mode} = body;

  try {

    // ────────────────────────────────────────
    // build_profile  — Gemini once, cache 24h
    // ────────────────────────────────────────
    if (mode==='build_profile') {
      const {watched=[], traktHistory=[], onboarding=null} = body;
      const all = [...new Set([...watched,...traktHistory])];
      const source = all.length>=2 ? all : onboarding?.favoriteMovies||all;
      const cacheKey = 'profile_'+hashStr(source.slice().sort().join(','));

      const cached = await cacheGet(cacheKey);
      if (cached) return res.status(200).json({profile:cached,cached:true});

      if (!source.length) {
        const empty = {genres:['drama'],decades:[2010,2000],directors:[],
          keywords:[],mood:'cerebral',avoid_genres:[],disliked_keywords:[]};
        return res.status(200).json({profile:empty,cached:false});
      }

      const raw = await gemini(
        'Analise gosto cinematográfico. Responda SOMENTE JSON válido sem markdown.',
        `Filmes assistidos: ${source.slice(0,40).join(', ')}.
${onboarding?`Diretor favorito: ${onboarding.director}. Década preferida: ${onboarding.decade}.`:''}
Retorne:
{
  "genres": ["2-5 gêneros em inglês lowercase"],
  "decades": [décadas como números ex: 1990, 2000],
  "directors": ["diretores do estilo"],
  "keywords": ["5-10 temas em inglês ex: neo-noir, anti-hero, slow-burn"],
  "mood": "dark|cerebral|tense|uplifting|romantic|adventurous|nostalgic",
  "avoid_genres": ["gêneros ausentes no histórico"],
  "disliked_keywords": []
}`, 500
      );

      const profile = parseJSON(raw) || {
        genres:['drama'],decades:[2010],directors:[],
        keywords:[],mood:'cerebral',avoid_genres:[],disliked_keywords:[]
      };

      await cacheSet(cacheKey, profile, 86400);
      return res.status(200).json({profile, cached:false});
    }

    // ────────────────────────────────────────
    // recommend  — TMDB discover + rank + explain
    // Cache 1h per (profile + day + genre)
    // ────────────────────────────────────────
    if (mode==='recommend') {
      const {profile, watched=[], traktHistory=[], genre='Todos'} = body;
      if (!profile) return res.status(400).json({error:'Missing profile'});

      const allWatched = [...new Set([...watched,...traktHistory])].map(t=>t.toLowerCase());
      const today = new Date().toISOString().slice(0,10);
      const cacheKey = 'recs_'+hashStr(JSON.stringify(profile)+today+genre);

      const cached = await cacheGet(cacheKey);
      if (cached) return res.status(200).json({recommendations:cached,cached:true});

      const profileGenreIds = genreIds(profile.genres||[]);
      const avoidIds        = genreIds(profile.avoid_genres||[]);

      const params = {
        sort_by:'vote_average.desc',
        'vote_count.gte':300,
        'vote_average.gte':6.0,
        include_adult:false,
        page:Math.floor(Math.random()*5)+1,
      };

      if (genre!=='Todos' && GENRE_MAP[genre.toLowerCase()]) {
        params.with_genres = GENRE_MAP[genre.toLowerCase()];
      } else if (profileGenreIds.length) {
        params.with_genres = profileGenreIds.slice(0,2).join(',');
      }
      if (avoidIds.length) params.without_genres = avoidIds.join(',');

      if (profile.decades?.length===1) {
        const d = profile.decades[0];
        params['primary_release_date.gte'] = `${d}-01-01`;
        params['primary_release_date.lte'] = `${d+9}-12-31`;
      }

      const discovered = await tmdbFetch('/discover/movie', params);
      const movies = (discovered.results||[])
        .filter(m=>!allWatched.includes(m.title?.toLowerCase()))
        .map(m=>({...m, _score:scoreMovie(m, profileGenreIds)}))
        .sort((a,b)=>b._score-a._score)
        .slice(0,8);

      // One Gemini call for all explanations
      const profileSummary = [
        profile.genres?.join(', '), profile.mood,
        profile.keywords?.slice(0,4).join(', ')
      ].filter(Boolean).join(' · ');
      const titles = movies.slice(0,6).map(m=>m.title).join(', ');

      let reasons = {};
      try {
        const raw = await gemini(
          'Crítico de cinema. Responda SOMENTE JSON sem markdown.',
          `Perfil: ${profileSummary}
Filmes: ${titles}
Escreva UMA frase (max 10 palavras) em português por que cada filme combina com este perfil.
{"reasons":{"Título":"frase"}}`, 400
        );
        reasons = parseJSON(raw)?.reasons || {};
      } catch {}

      const result = movies.slice(0,6).map(m=>({
        id:m.id, tmdb_id:m.id, title:m.title,
        year:m.release_date?.slice(0,4),
        score:m.vote_average?.toFixed(1),
        overview:m.overview,
        poster_path:   m.poster_path   ? IMG+'w342'+m.poster_path   : null,
        backdrop_path: m.backdrop_path ? IMG+'w780'+m.backdrop_path : null,
        genre_ids:m.genre_ids, color:'#0e0e1a', emoji:'🎬',
        aiReason: reasons[m.title] || '',
        _score:m._score,
      }));

      await cacheSet(cacheKey, result, 3600);
      return res.status(200).json({recommendations:result, cached:false});
    }

    // ────────────────────────────────────────
    // keywords  — TMDB only, no LLM, cache 24h
    // Returns keywords + similar movies for a film
    // Great for "because you liked X" feature
    // ────────────────────────────────────────
    if (mode==='keywords') {
      const {tmdb_id} = body;
      if (!tmdb_id) return res.status(400).json({error:'Missing tmdb_id'});
      const cacheKey = 'kw_'+tmdb_id;
      const cached = await cacheGet(cacheKey);
      if (cached) return res.status(200).json(cached);

      const [kwData, simData] = await Promise.all([
        tmdbFetch(`/movie/${tmdb_id}/keywords`),
        tmdbFetch(`/movie/${tmdb_id}/similar`),
      ]);

      const keywords = (kwData.keywords||[]).slice(0,10).map(k=>({id:k.id,name:k.name}));
      const similar  = (simData.results||[]).slice(0,6).map(m=>({
        id:m.id, tmdb_id:m.id, title:m.title,
        year:m.release_date?.slice(0,4), score:m.vote_average?.toFixed(1),
        poster_path:m.poster_path?IMG+'w185'+m.poster_path:null,
        emoji:'🎬', color:'#0e0e1a',
      }));

      const result = {keywords, similar};
      await cacheSet(cacheKey, result, 86400);
      return res.status(200).json(result);
    }

    // ────────────────────────────────────────
    // search  — LLM parses intent → TMDB executes
    // ────────────────────────────────────────
    if (mode==='search') {
      const {query} = body;
      const cacheKey = 'srch_'+hashStr(query||'');
      const cached = await cacheGet(cacheKey);
      if (cached) return res.status(200).json({results:cached,cached:true});

      const raw = await gemini(
        'Analise busca cinematográfica. JSON apenas.',
        `Busca: "${query}"
{"type":"movie|person|vibe","movies":["títulos"],"person":"nome ou null","genres":["en lowercase"],"mood":"mood ou null"}`,
        200
      );
      const intent = parseJSON(raw) || {type:'vibe',genres:[]};
      let results = [];

      if (intent.type==='person' && intent.person) {
        const d = await tmdbFetch('/search/person',{query:intent.person});
        results = (d.results||[]).slice(0,4).map(p=>({
          id:'p'+p.id, tmdb_id:p.id, name:p.name, title:p.name,
          photo_url:   p.profile_path?IMG+'w185'+p.profile_path:null,
          photo_url_lg:p.profile_path?IMG+'w342'+p.profile_path:null,
          known_for:p.known_for_department, emoji:'👤', type:'person',
        }));
      } else if (intent.type==='movie' && intent.movies?.length) {
        for (const t of intent.movies.slice(0,4)) {
          const d = await tmdbFetch('/search/movie',{query:t});
          if (d.results?.[0]) {
            const m=d.results[0];
            results.push({
              id:m.id,tmdb_id:m.id,title:m.title,
              year:m.release_date?.slice(0,4),score:m.vote_average?.toFixed(1),
              poster_path:m.poster_path?IMG+'w185'+m.poster_path:null,
              backdrop_path:m.backdrop_path?IMG+'w780'+m.backdrop_path:null,
              overview:m.overview,emoji:'🎬',color:'#0e0e1a',type:'movie',
            });
          }
        }
      } else {
        const ids = genreIds(intent.genres||[]);
        const p = {sort_by:'vote_average.desc','vote_count.gte':200,'vote_average.gte':6.5};
        if (ids.length) p.with_genres = ids.slice(0,2).join(',');
        const d = await tmdbFetch('/discover/movie',p);
        results = (d.results||[]).slice(0,6).map(m=>({
          id:m.id,tmdb_id:m.id,title:m.title,
          year:m.release_date?.slice(0,4),score:m.vote_average?.toFixed(1),
          poster_path:m.poster_path?IMG+'w185'+m.poster_path:null,
          overview:m.overview,emoji:'🎬',color:'#0e0e1a',type:'movie',
        }));
      }

      await cacheSet(cacheKey, results, 3600);
      return res.status(200).json({results, intent, cached:false});
    }

    // ────────────────────────────────────────
    // explain  — short LLM call, profile-aware
    // ────────────────────────────────────────
    if (mode==='explain') {
      const {title, year, profile} = body;
      const summary = profile
        ? [profile.genres?.join(', '),profile.mood,profile.keywords?.slice(0,3).join(', ')].filter(Boolean).join(' · ')
        : 'cinema de qualidade';
      const text = await gemini(
        'Crítico de cinema. Uma frase em português, max 20 palavras.',
        `Perfil: ${summary}\nFilme: ${title} (${year})\nPor que combina com este perfil?`,
        80
      );
      return res.status(200).json({content:[{type:'text',text:text.trim()}]});
    }

    // ────────────────────────────────────────
    // similar  — pure TMDB, no LLM, cache 24h
    // ────────────────────────────────────────
    if (mode==='similar') {
      const {tmdb_id} = body;
      if (!tmdb_id) return res.status(400).json({error:'Missing tmdb_id'});
      const cacheKey = 'sim_'+tmdb_id;
      const cached = await cacheGet(cacheKey);
      if (cached) return res.status(200).json({movies:cached});
      const d = await tmdbFetch(`/movie/${tmdb_id}/similar`);
      const movies = (d.results||[]).slice(0,6).map(m=>({
        id:m.id,tmdb_id:m.id,title:m.title,
        year:m.release_date?.slice(0,4),score:m.vote_average?.toFixed(1),
        poster_path:m.poster_path?IMG+'w185'+m.poster_path:null,
        emoji:'🎬',color:'#0e0e1a',
      }));
      await cacheSet(cacheKey, movies, 86400);
      return res.status(200).json({movies});
    }

    // ────────────────────────────────────────
    // person  — TMDB + one LLM sentence, cache 24h
    // ────────────────────────────────────────
    if (mode==='person') {
      const {name, tmdb_id} = body;
      const cacheKey = 'person_'+(tmdb_id||hashStr(name||''));
      const cached = await cacheGet(cacheKey);
      if (cached) return res.status(200).json(cached);

      let personId = tmdb_id;
      if (!personId && name) {
        const s = await tmdbFetch('/search/person',{query:name});
        personId = s.results?.[0]?.id;
      }
      if (!personId) return res.status(404).json({error:'Not found'});

      const [details, whyRaw] = await Promise.all([
        tmdbFetch(`/person/${personId}`,{append_to_response:'movie_credits'}),
        gemini('Crítico. Uma frase em português.',
          `Por que um cinéfilo gostaria do trabalho de "${name||'este cineasta'}"?`, 80),
      ]);

      const credits = details.movie_credits;
      const films = ((credits?.cast||[]).concat(credits?.crew?.filter(c=>c.job==='Director')||[]))
        .sort((a,b)=>(b.vote_count||0)-(a.vote_count||0))
        .filter((x,i,arr)=>arr.findIndex(y=>y.id===x.id)===i)
        .slice(0,8)
        .map(m=>({
          id:m.id,tmdb_id:m.id,title:m.title,
          year:m.release_date?.slice(0,4),score:m.vote_average?.toFixed(1),
          poster_path:m.poster_path?IMG+'w185'+m.poster_path:null,
          emoji:'🎬',color:'#0e0e1a',
        }));

      const result = {
        ...details,
        photo_url:   details.profile_path?IMG+'w185'+details.profile_path:null,
        photo_url_lg:details.profile_path?IMG+'w342'+details.profile_path:null,
        films, whyText:whyRaw.trim(),
      };
      await cacheSet(cacheKey, result, 86400);
      return res.status(200).json(result);
    }

    // ────────────────────────────────────────
    // dislike  — update profile client-side
    // Removes keyword/genre from saved profile
    // ────────────────────────────────────────
    if (mode==='dislike') {
      const {profile, keyword, genre} = body;
      if (!profile) return res.status(400).json({error:'Missing profile'});
      const updated = {...profile};
      if (keyword) {
        updated.disliked_keywords = [...new Set([...(updated.disliked_keywords||[]), keyword])];
        updated.keywords = (updated.keywords||[]).filter(k=>k!==keyword);
      }
      if (genre) {
        updated.avoid_genres = [...new Set([...(updated.avoid_genres||[]), genre])];
        updated.genres = (updated.genres||[]).filter(g=>g!==genre);
      }
      return res.status(200).json({profile:updated});
    }

    return res.status(400).json({error:`Unknown mode: ${mode}`});

  } catch(e) {
    console.error('[recommend]', e.message);
    return res.status(500).json({error:e.message});
  }
}
