const fs = require('fs');
const express = require('express');
const ejs = require('ejs');
const qs = require('qs');
const csv2json = require('./script/csv2json.js');
const json2csv = require('./script/json2csv.js');
const Enumerable = require('linq');
const multer = require('multer')
const jwt = require('jsonwebtoken');
const AsyncLock = require('async-lock');

var lock = new AsyncLock({ timeout: 1000 * 30 });

const App = express();
const AppConst = JSON.parse(fs.readFileSync("./data/appconst.json", "utf-8"));
const Setting = JSON.parse(fs.readFileSync("./data/setting.json", "utf-8"));

const MS1DAY = 1 * 24 * 60 * 60 * 1000;
const MS10DAY = 10 * 24 * 60 * 60 * 1000;
const DATAFOLDER = "./data/";
const CSVFILENAME = "all_word.csv";
const CSVFILE = DATAFOLDER + CSVFILENAME;
const CSVFILEBACKUP = DATAFOLDER + "_" + CSVFILENAME;

const dataInCsv = fs.readFileSync(CSVFILE);
var listWord = csv2json(dataInCsv.toString(), { parseNumbers: true });
DEBUGForValue("listWord.length", listWord.length);
var backupListQuestion;
var session = [];

//デバッグ動作ラッパー(値用)
function DEBUGForValue(header, content) {
    //デバッグモードか
    if (Setting.debug == AppConst.ON) {
        console.debug("[DEBUG]" + header + ": " + content);
    }

    return;
}

//デバッグ動作ラッパー(メッセージ用)
function DEBUGForMessage(message) {
    //デバッグモードか
    if (Setting.debug == AppConst.ON) {
        console.debug("[DEBUG]" + message);
    }

    return;
}

/**
 * 致命的エラー
 * エラー情報を出力して終了する。
 */
function fatal(func, errorInfo) {
    console.log("function:" + func);
    console.log(errorInfo);
    process.exit();
}

App.engine('ejs', ejs.renderFile);
App.get('/jquery-3.6.0.min.js',
    /**
     * jqueryファイルを返す。
     * @param {object} req expressパッケージから引用
     * @param {object} res expressパッケージから引用
     */
    (req, res) => {
        res.send(fs.readFileSync("./script/jquery-3.6.0.min.js", "utf-8"));
    });
App.get('/LICENSE',
    /**
     * jqueryファイルを返す。
     * @param {object} req expressパッケージから引用
     * @param {object} res expressパッケージから引用
     */
    (req, res) => {
        res.header({
            "Content-Type": "text/plain"
        });
        res.send(fs.readFileSync("./LICENSE", "utf-8"));
    });
App.get('/',
    /**
     * ツールページを返す。
     * @param {object} req expressパッケージから引用
     * @param {object} res expressパッケージから引用
     */
    (req, res) => {
        res.render('main.ejs',
            /**
             * ejs渡し初期化子
             * @property {JSON} AppConst スペルミス防止定数
             * @property {JSON} Setting ツール設定
             */
            {
                AppConst: AppConst,
                Setting: Setting
            });
    });
App.get(Setting.nodejs.urlAjaxGetQuestion,
    async (req, res) => {
        let indexSession = -1;
        let listQuestion;

        //マルチユーザーモード、かつ、認証ヘッダーがあるか
        if (Setting.multiUser && (req.headers.hasOwnProperty("authentication"))) {
            let token = req.headers.authentication.split(" ");

            //Bearer認証ではないか
            if (token[0] != "Bearer") {
                res.status(400).end();
                return;
            }

            indexSession = session.findIndex(
                (value, index, array) => {
                    //セッション管理にトークンがあるか
                    if (value.token == token[1]) {
                        return true;
                    }
                });

            //セッション管理にトークンがないか
            if (indexSession == -1) {
                res.status(403).end();
                return;
            }

            try {
                jwt.verify(token[1], session[indexSession].key);
            } catch (error) {
                //トークンが期限切れか
                if (error.name == "TokenExpiredError") {
                    res.status(408).end();
                }
                else {
                    res.status(403).end();
                }

                return;
            }
        }

        let query = req.url.split("?");
        query = qs.parse(query[1]);
        let indexQuestion = query[Setting.commonClSv.indexQuestion];
        DEBUGForValue("indexQuestion", indexQuestion);
        let now = Date.now();

        //1問目か
        if (indexQuestion == "0") {
            //マルチユーザーモードか
            if (Setting.multiUser) {
                //トークンがないか
                if (indexSession == -1) {
                    lock.acquire("session",
                        (done) => {
                            //セッション数上限か
                            if (session.length == Setting.maxUser) {
                                let tmpSession = [];

                                //無効セッションチェックループ
                                for (let index = 0; index < session.length; index++) {
                                    const element = session[index];
                                    try {
                                        jwt.verify(element.token, element.key);
                                    } catch (error) {
                                        continue;
                                    }
                                    tmpSession.push(element);
                                }

                                session = tmpSession;
                            }

                            //セッション数上限か
                            if (session.length == Setting.maxUser) {
                                res.status(503).end();
                                return;
                            }
                            else {
                                let token = jwt.sign({ start: now }, now.toString(), { expiresIn: "1h" });
                                session.push({
                                    token: token,
                                    key: now.toString()
                                });
                                indexSession = session.length - 1;
                            }

                            done();
                        },
                        (err, ret) => {
                            if (err) {
                                fatal("(" + Setting.nodejs.urlAjaxGetQuestion + ")", err);
                            }
                        });
                }
                else {
                    session[indexSession]["listQuestion"] = null;
                }
            }

            //問題作成
            listQuestion = getListQuestion(query, now);

            //マルチユーザーモードか
            if (Setting.multiUser) {
                session[indexSession]["listQuestion"] = listQuestion;
            }
            else {
                backupListQuestion = listQuestion;
            }
        }
        else {
            //マルチユーザーモードか
            if (Setting.multiUser) {
                listQuestion = session[indexSession]["listQuestion"];
            } else {
                listQuestion = backupListQuestion;
            }
        }

        //シングルユーザーモード、かつ、クエリーに結果情報があるか
        if (!Setting.multiUser && (query.hasOwnProperty(Setting.commonClSv.headword))) {
            let indexListWord = listWord.findIndex(
                (value, index, array) => {
                    if (value.headword == query.headword) {
                        return true;
                    }
                });

            //視認性を上げるために習熟度はクライアントのカウンタ値では秒精度にする
            listWord[indexListWord].proficiency = Math.floor(Number(query.timeAnswer) / 2);

            //ソートするため日時を数値で持つ
            listWord[indexListWord].last_check = now;
        }

        let jsonRes = {};

        //最後の問題だったか
        if (indexQuestion == listQuestion.length) {
            let stopRes = {};
            stopRes[Setting.commonClSv.headword] = "-";
            jsonRes = stopRes;
        }
        else {
            let indexListWord = listWord.findIndex(
                (value, index, array) => {
                    if (value.headword == listQuestion[indexQuestion]) {
                        return true;
                    }
                });
            jsonRes = Object.assign({}, listWord[indexListWord]);
        }

        //1問目か
        if (indexQuestion == "0") {
            //マルチユーザーモードか
            if (Setting.multiUser) {
                jsonRes[Setting.commonClSv.token] = session[indexSession].token;
            }

            jsonRes[Setting.commonClSv.countQuestion] = listQuestion.length;
        }

        //シングルユーザーモード、かつ、STOPボタン押下か
        if (!Setting.multiUser && query.hasOwnProperty(Setting.commonClSv.stop)) {
            //バックアップファイルがあるか
            if (fs.existsSync(CSVFILEBACKUP)) {
                fs.unlinkSync(CSVFILEBACKUP);
            }

            fs.renameSync(CSVFILE, CSVFILEBACKUP);
            let listWordCsv = json2csv(listWord);
            let listWordCsvCrLf = [];

            //Windows改行にするループ
            // LibreCalcが改行のカスタマイズができないため
            for (const iterator of listWordCsv.split("\n")) {
                listWordCsvCrLf.push(iterator.replace(/\n$/, ""));
            }

            listWordCsv = listWordCsvCrLf.join("\r\n");
            fs.writeFileSync(CSVFILE, listWordCsv);
        }

        res.send(JSON.stringify(jsonRes));
    });

//問題作成
function getListQuestion(params, now) {
    let afterPos = Enumerable.from(listWord).where(
        (value) => {
            //名詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(0) == "O") && (value.pos_0 == "O")) {
                return true;
            }
            //動詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(1) == "O") && (value.pos_1 == "O")) {
                return true;
            }
            //形容詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(2) == "O") && (value.pos_2 == "O")) {
                return true;
            }
            //前置詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(3) == "O") && (value.pos_3 == "O")) {
                return true;
            }
            //副詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(4) == "O") && (value.pos_4 == "O")) {
                return true;
            }
            //接続詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(5) == "O") && (value.pos_5 == "O")) {
                return true;
            }
            //代名詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(6) == "O") && (value.pos_6 == "O")) {
                return true;
            }
            //数詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(7) == "O") && (value.pos_7 == "O")) {
                return true;
            }
            //冠詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(8) == "O") && (value.pos_8 == "O")) {
                return true;
            }
            //be動詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(9) == "O") && (value.pos_9 == "O")) {
                return true;
            }
            //do動詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(10) == "O") && (value.pos_10 == "O")) {
                return true;
            }
            //have動詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(11) == "O") && (value.pos_11 == "O")) {
                return true;
            }
            //助動詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(12) == "O") && (value.pos_12 == "O")) {
                return true;
            }
            //間投詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(13) == "O") && (value.pos_13 == "O")) {
                return true;
            }
            //不定詞条件、かつ、品詞が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(14) == "O") && (value.pos_14 == "O")) {
                return true;
            }
            //他条件、かつ、他が含まれる単語か
            if ((params[Setting.commonClSv.hinsi].charAt(15) == "O") && (value.pos_other == "O")) {
                return true;
            }

            return false;
        }).select(value => value.headword).distinct().toArray();

    let beforeSearch = [];

    //次検索用配列作成ループ
    for (const iterator of listWord) {
        //更新対象行、かつ、前検索の対象か
        //###答えが全部埋めれたら最初の条件を外す
        if ((iterator.answer != "") && (iterator.proficiency != "") && afterPos.includes(iterator.headword)) {
            beforeSearch.push(iterator);
        }
    }

    let ret = Enumerable.from(beforeSearch).where(
        (value) => {
            //A1難易度外条件、かつ、該当か
            if ((params[Setting.commonClSv.nanido].charAt(0) == "X") && (value.CEFR == "A1")) {
                return false;
            }

            //A2難易度外条件、かつ、該当か
            if ((params[Setting.commonClSv.nanido].charAt(1) == "X") && (value.CEFR == "A2")) {
                return false;
            }

            //B1難易度外条件、かつ、該当か
            if ((params[Setting.commonClSv.nanido].charAt(2) == "X") && (value.CEFR == "B1")) {
                return false;
            }

            //B2難易度外条件、かつ、該当か
            if ((params[Setting.commonClSv.nanido].charAt(3) == "X") && (value.CEFR == "B2")) {
                return false;
            }

            //シングルユーザーモードか
            if (!Setting.multiUser) {
                //0秒以上1秒未満外条件、かつ、該当か
                if ((params[Setting.commonClSv.proficiency].charAt(0) == "X") && (value.proficiency == 0)) {
                    return false;
                }

                //1秒以上2秒未満外条件、かつ、該当か
                if ((params[Setting.commonClSv.proficiency].charAt(1) == "X") && (value.proficiency == 1)) {
                    return false;
                }

                //2秒以上5秒未満外条件、かつ、該当か
                if ((params[Setting.commonClSv.proficiency].charAt(2) == "X") && ((value.proficiency >= 2) && (value.proficiency < 5))) {
                    return false;
                }

                //5秒以上9秒未満外条件、かつ、該当か
                if ((params[Setting.commonClSv.proficiency].charAt(3) == "X") && ((value.proficiency >= 5) && (value.proficiency < 9))) {
                    return false;
                }

                //9秒以上外条件、かつ、該当か
                if ((params[Setting.commonClSv.proficiency].charAt(4) == "X") && (value.proficiency == 9)) {
                    return false;
                }

                //1日未満外条件、かつ、該当か
                if ((params[Setting.commonClSv.dayElapsed].charAt(0) == "X") && (value.last_check + MS1DAY >= now)) {
                    return false;
                }

                //10日未満外条件、かつ、該当か
                if ((params[Setting.commonClSv.dayElapsed].charAt(1) == "X") && (value.last_check + MS1DAY < now) && (value.last_check + MS10DAY >= now)) {
                    return false;
                }

                //確認済み外条件、かつ、該当か
                if ((params[Setting.commonClSv.dayElapsed].charAt(2) == "X") && ((value.proficiency == -1) || (value.proficiency == -2))) {
                    return false;
                }

                //未確認外条件、かつ、該当か
                if ((params[Setting.commonClSv.dayElapsed].charAt(3) == "X") && (value.proficiency == -1)) {
                    return false;
                }

                //対象外外条件、かつ、該当か
                if ((params[Setting.commonClSv.dayElapsed].charAt(4) == "X") && (value.proficiency == -2)) {
                    return false;
                }
            }

            return true;
        })
        .orderBy(value => value.last_check).select(value => value.headword);

    //シャッフル指定か
    if (params[Setting.commonClSv.shuffle] == "O") {
        ret = ret.shuffle();
    }

    ret = ret.toArray();
    return ret;
}

App.get(Setting.nodejs.urlAjaxDownload,
    (req, res) => {
        //マルチユーザーモードか
        if (Setting.multiUser) {
            res.status(501).end();
        } else {
            //確認日を埋め込むループ
            for (let index = 0; index < listWord.length; index++) {
                //確認日が存在するか
                if (listWord[index].last_check != "") {
                    listWord[index].last_check_string = (new Date(listWord[index].last_check)).toString();
                }
            }

            let listWordCsv = json2csv(listWord);
            res.set("Content-Type", "text/csv");
            res.send(listWordCsv);
        }
    });
App.post(Setting.nodejs.urlAjaxUpload, multer({ dest: DATAFOLDER }).single(Setting.commonClSv.file),
    (req, res, next) => {
        //マルチユーザーモードか
        if (Setting.multiUser) {
            res.status(501).end();
        } else {
            //バックアップファイルがあるか
            if (fs.existsSync(CSVFILEBACKUP)) {
                fs.unlinkSync(CSVFILEBACKUP);
            }

            fs.renameSync(CSVFILE, CSVFILEBACKUP);
            fs.renameSync(DATAFOLDER + req.file.filename, CSVFILE);
            res.status(201).end();
        }
    });
App.listen(Setting.nodejs.port);
