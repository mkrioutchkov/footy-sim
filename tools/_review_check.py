import json, subprocess, sys
EXE = r"C:\Users\maxkr\Documents\dev\Game\footy-sim\build\live.exe"
seeds = [1,2,3,4,5,7,11,42]
for s in seeds:
    out = subprocess.run([EXE, str(s), "90", "--summary", "--no-debug"],
                         capture_output=True, text=True, timeout=120).stdout
    try:
        j = json.loads(out)
    except Exception as e:
        print(f"seed {s}: PARSE FAIL {e} :: {out[:120]!r}"); continue
    hs, as_ = j["homeScore"], j["awayScore"]
    players = j["players"]
    pg = sum(p["goals"] for p in players)
    pa = sum(p["assists"] for p in players)
    half = j.get("half"); clock = j.get("clockMs")
    ms = j.get("matchState")
    addedT = j.get("addedTime"); addedMin = j.get("addedTimeAnnouncedMin")
    home_g = sum(p["goals"] for p in players if p["team"]=="home")
    away_g = sum(p["goals"] for p in players if p["team"]=="away")
    offs = j.get("offsides"); throughC = j.get("throughBallsCompleted")
    ok = "OK" if (pg == hs+as_ and home_g==hs and away_g==as_) else "MISMATCH"
    print(f"seed {s}: {hs}-{as_} pG={pg}(h{home_g}/a{away_g}) A={pa} half={half} clk={clock} state={ms} addT={addedT}/{addedMin}min off={offs} thruC={throughC} -> {ok}")
    if ok=="MISMATCH":
        for p in players:
            if p["goals"]>0 or p["assists"]>0:
                print(f"   {p['team']} #{p['id']} {p['name']} g={p['goals']} a={p['assists']}")
