// Copyright 2021-2024 the Kubeapps contributors.
// SPDX-License-Identifier: Apache-2.0
import type { ServiceType } from "@bufbuild/protobuf";
import { createPromiseClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { Interceptor } from "@connectrpc/connect/dist/cjs/interceptor";
import { PromiseClient } from "@connectrpc/connect/dist/cjs/promise-client";
import { Transport } from "@connectrpc/connect/dist/cjs/transport";
import { PackagesService } from "gen/kubeappsapis/core/packages/v1alpha1/packages_connect";
import { RepositoriesService } from "gen/kubeappsapis/core/packages/v1alpha1/repositories_connect";
import { PluginsService } from "gen/kubeappsapis/core/plugins/v1alpha1/plugins_connect";
import {
  FluxV2PackagesService,
  FluxV2RepositoriesService,
} from "gen/kubeappsapis/plugins/fluxv2/packages/v1alpha1/fluxv2_connect";
import {
  HelmPackagesService,
  HelmRepositoriesService,
} from "gen/kubeappsapis/plugins/helm/packages/v1alpha1/helm_connect";
import {
  KappControllerPackagesService,
  KappControllerRepositoriesService,
} from "gen/kubeappsapis/plugins/kapp_controller/packages/v1alpha1/kapp_controller_connect";
import { ResourcesService } from "gen/kubeappsapis/plugins/resources/v1alpha1/resources_connect";

import { Auth } from "./Auth";
import * as URL from "./url";

function parseCluster(url: string): { cluster?: string } {
  // URL의 해시(#) 이후 부분만 사용
  const hashPath = url.split("#")[1] ?? "";

  const clusterMatch = hashPath.match(/\/c\/([^/]+)/);

  return {
    cluster: clusterMatch ? clusterMatch[1] : undefined,
  };
}

export class KubeappsGrpcClient {
  private transport: Transport;
  private saToken?: string; // 캐시용
  private saTokenPromise?: Promise<string>; // 동시에 여러 요청이 발생했을 때 처리
  private saTokenExpiry?: Date;

  // Creates a client with a transport, ensuring the transport includes the auth header.
  constructor(token?: string) {
    // CUD 오퍼레이팅 시 정상 동작을 위하여
    // 프론트엔드 KubeappsGrpcClient 의 인터셉터에서
    // Kubeapps 관리자 서비스어카운트에 해당하는 인증 헤더 주입
    const auth: Interceptor = next => async req => {
      // url에서 클러스터 데이터 추출
      const cluster = parseCluster(req.url);

      // deployment 리소스의 특정 경로에 새 configmap을 마운트하는 방식으로 아래 환경변수 사용 필요
      const kubeappsSaNamespace = "kubeapps";
      const kubeappsSaName = "kubeapps-admin";
      const openApiHostname = "10.120.105.31:31004";
      const tokenRequestSaToken =
        "eyJhbGciOiJSUzI1NiIsImtpZCI6ImplcktWSnRndDc3Y2l1VXUwSVk5SVBKMXBaMlRIdjRzanRkYTM5V3QxZTQifQ.eyJpc3MiOiJrdWJlcm5ldGVzL3NlcnZpY2VhY2NvdW50Iiwia3ViZXJuZXRlcy5pby9zZXJ2aWNlYWNjb3VudC9uYW1lc3BhY2UiOiJrdWJlYXBwcyIsImt1YmVybmV0ZXMuaW8vc2VydmljZWFjY291bnQvc2VjcmV0Lm5hbWUiOiJrdWJlYXBwcy10b2tlbi1yZXF1ZXN0Iiwia3ViZXJuZXRlcy5pby9zZXJ2aWNlYWNjb3VudC9zZXJ2aWNlLWFjY291bnQubmFtZSI6Imt1YmVhcHBzLXRva2VuLXJlcXVlc3QiLCJrdWJlcm5ldGVzLmlvL3NlcnZpY2VhY2NvdW50L3NlcnZpY2UtYWNjb3VudC51aWQiOiJiYjUxMmUzNy1iZjUyLTRmNjAtYjgyNy02MDBhZDFiNzczNWUiLCJzdWIiOiJzeXN0ZW06c2VydmljZWFjY291bnQ6a3ViZWFwcHM6a3ViZWFwcHMtdG9rZW4tcmVxdWVzdCJ9.EqB53u6pcRntHdLj0qkuYud2e_FohLtcINT2pFQbBaRsCNW_2TVVNkCxKhg1yKCSTUonBQ8KUMEN9tv1oxm6dRVp2AOBe-AqYHoboyM34hpddr6_YkxZPyhdsvamang6-G7-W_leW2HfYgtDG2O-xj_2yDHbngIliT10iHNosEqHAp3jAFgOduRnbLxU7sXKILzdf02UcKjROKPBEJG3eT5XoDSW4_7QbNuG9cdsfOK_944MJ-1mVBS0Jlv5e2dq0eidIPglKwO6CW6xJEoF2drFj2v2l1pgwq_TpiORqbc-fUybkuz32UzcPtzL2qG7omljj6PSA7wb-nMN8V2c2g";

      // 특정 클러스터의 'kubeapps-admin' SA 토큰 발급
      // 이미 발급된 토큰이 있고, 만료까지 1분 이상 남았다면 재사용
      // 불필요한 토큰 재발급 방지, 성능 최적화
      const getSaToken = async (): Promise<string> => {
        if (
          this.saToken &&
          this.saTokenExpiry &&
          this.saTokenExpiry.getTime() > Date.now() + 60_000
        ) {
          return this.saToken;
        }

        // 동시에 여러 요청이 들어올 경우 중복 fetch 방지
        // Promise를 공유하여 race condition 방지
        if (!this.saTokenPromise) {
          this.saTokenPromise = fetch(
            `http://${openApiHostname}/k8s/api/v1/clusters/${cluster}/namespaces/${kubeappsSaNamespace}/serviceaccounts/${kubeappsSaName}/token`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token ?? tokenRequestSaToken}`, // 로그인한 사용자의 OIDC 토큰 대신 token request secret을 사용하여 open-api-k8s에 인증
              },
              body: JSON.stringify({
                apiVersion: "authentication.k8s.io/v1",
                kind: "TokenRequest",
                metadata: {
                  name: kubeappsSaName,
                  namespace: kubeappsSaNamespace,
                },
                spec: {
                  audiences: ["kubernetes"],
                  expirationSeconds: 3600,
                },
              }),
            },
          )
            .then(res => {
              // 토큰 발급 실패 처리
              if (!res.ok) {
                throw new Error("Failed to fetch SA token");
              }
              return res.json();
            })
            .then(data => {
              // 응답에서 token과 만료 시간 추출
              this.saToken = data.status?.token;
              if (data.status?.expirationTimestamp) {
                this.saTokenExpiry = new Date(data.status.expirationTimestamp);
              } else {
                // // 만료 정보 없으면 기본 1시간 후로 설정
                this.saTokenExpiry = new Date(Date.now() + 3600 * 1000);
              }
              return this.saToken!;
            })
            .finally(() => {
              // Promise 해제
              this.saTokenPromise = undefined;
            });
        }

        return this.saTokenPromise; // 중복 방지용 Promise 반환
      };

      // CUD 요청이면 SA 토큰 사용
      const isCudRequest =
        req.url.includes("PackagesService/CreateInstalledPackage") ||
        req.url.includes("PackagesService/UpdateInstalledPackage") ||
        req.url.includes("PackagesService/DeleteInstalledPackage");

      if (isCudRequest) {
        // CUD 요청이면 SA 토큰 가져오기
        const saToken = await getSaToken();
        req.header.set("Authorization", `Bearer ${saToken}`);
      } else {
        // 그 외 요청은 로그인한 사용자의 OIDC 토큰 사용
        const t = token ?? Auth.getAuthToken();
        if (t) {
          req.header.set("Authorization", `Bearer ${t}`);
        }
      }

      // 다음 interceptor 또는 실제 gRPC 호출 진행
      return await next(req);
    };

    // gRPC transport 생성
    this.transport = createGrpcWebTransport({
      baseUrl: `./${URL.api.kubeappsapis}`,
      interceptors: [auth], // 인증 인터셉터 등록
    });
  }

  // getClientMetadata, if using token authentication, creates grpc metadata
  // and the token in the 'authorization' field
  public getClientMetadata(token?: string) {
    const t = token ? token : Auth.getAuthToken();
    return t ? new Headers({ Authorization: `Bearer ${t}` }) : undefined;
  }

  public getGrpcClient = <T extends ServiceType>(service: T): PromiseClient<T> => {
    return createPromiseClient(service, this.transport);
  };

  // Core APIs
  public getPackagesServiceClientImpl() {
    return this.getGrpcClient(PackagesService);
  }

  public getRepositoriesServiceClientImpl() {
    return this.getGrpcClient(RepositoriesService);
  }

  public getPluginsServiceClientImpl() {
    return this.getGrpcClient(PluginsService);
  }

  // Resources API
  //
  // The resources API client implementation takes an optional token
  // only because it is used to validate token authentication before
  // the token is stored.
  // TODO: investigate the token here.
  public getResourcesServiceClientImpl() {
    return this.getGrpcClient(ResourcesService);
  }

  // Plugins (packages/repositories) APIs
  // TODO(agamez): ideally, these clients should be loaded automatically from a list of configured plugins

  // Helm
  public getHelmPackagesServiceClientImpl() {
    return this.getGrpcClient(HelmPackagesService);
  }
  public getHelmRepositoriesServiceClientImpl() {
    return this.getGrpcClient(HelmRepositoriesService);
  }

  // KappController
  public getKappControllerPackagesServiceClientImpl() {
    return this.getGrpcClient(KappControllerPackagesService);
  }
  public getKappControllerRepositoriesServiceClientImpl() {
    return this.getGrpcClient(KappControllerRepositoriesService);
  }
  // Fluxv2
  public getFluxv2PackagesServiceClientImpl() {
    return this.getGrpcClient(FluxV2PackagesService);
  }
  public getFluxV2RepositoriesServiceClientImpl() {
    return this.getGrpcClient(FluxV2RepositoriesService);
  }
}

export default KubeappsGrpcClient;
