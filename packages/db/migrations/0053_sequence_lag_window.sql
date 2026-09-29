-- 0053 · 号源序列落后窗口并发撞号修复（独立验收 N-01 / 原台账 A-07）
--
-- 0050 的 GREATEST(nextval, max) 口径有一个并发窗口：
-- 序列落后于现存最大号时，并发 N 路各自 nextval 得到 1..N（均 < max），
-- GREATEST 全部等于同一个 max → 调用方 +1 同号 → 23505 撞号；
-- 且 READ COMMITTED 下并发事务互不可见，重试时 max 不变 → 再撞 → 事务中止 500。
-- （独立验收实测：全新库 12 路并发派遣 1 路 INTERNAL_SERVER_ERROR）
--
-- 修法（台账口径）：函数内循环抬序列直至 nextval 越过现存最大值，
-- 之后纯 nextval 原子递增——nextval 本身并发安全，窗口彻底关闭。
-- 语义兼容：返回值仍保证"大于现存最大号"，调用方 +1 使用不变（可能跳号，无害）。

CREATE OR REPLACE FUNCTION public.threads_max_t_no()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  floor_no bigint;
  next_no bigint;
BEGIN
  SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 100)
    INTO floor_no
    FROM public.threads
   WHERE id ~ '^T-[0-9]+$';
  next_no := nextval('public.thread_no_seq');
  WHILE next_no <= floor_no LOOP
    next_no := nextval('public.thread_no_seq');
  END LOOP;
  RETURN next_no;
END;
$$;

CREATE OR REPLACE FUNCTION public.video_projects_max_vid_no()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  floor_no bigint;
  next_no bigint;
BEGIN
  SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 1000)
    INTO floor_no
    FROM public.video_projects
   WHERE id ~ '^VID-[0-9]+$';
  next_no := nextval('public.video_project_no_seq');
  WHILE next_no <= floor_no LOOP
    next_no := nextval('public.video_project_no_seq');
  END LOOP;
  RETURN next_no;
END;
$$;

GRANT EXECUTE ON FUNCTION public.threads_max_t_no() TO workloom_app, workloom_gateway;
GRANT EXECUTE ON FUNCTION public.video_projects_max_vid_no() TO workloom_app, workloom_gateway;
